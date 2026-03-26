require('dotenv').config();
// Sincronización verificada con Railway via GitHub - Prueba de despliegue automático
const express = require('express');
const cors = require('cors');
const path = require('path');
const xlsx = require('xlsx');
const db = require('./database');
const fs = require('fs');
const { processAccountingMovement, askAccountingQuestion } = require('./ai');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all PUC accounts with balances
app.get('/api/accounts', (req, res) => {
    const query = `
        SELECT a.*, 
               SUM(j.debit) as total_debit, 
               SUM(j.credit) as total_credit
        FROM accounts a
        LEFT JOIN journal_entries j ON a.code = j.account_code
        GROUP BY a.code
        ORDER BY a.code ASC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const accountsWithBalance = rows.map(r => {
            let balance = 0;
            const deb = r.total_debit || 0;
            const cred = r.total_credit || 0;
            
            if (r.type === 'Activo' || r.type === 'Gastos' || r.type === 'Costos') {
                balance = deb - cred;
            } else {
                balance = cred - deb;
            }
            return { ...r, balance };
        });
        
        res.json(accountsWithBalance);
    });
});

// Get the ledger (libro diario)
app.get('/api/ledger', (req, res) => {
    const query = `
        SELECT t.id, t.date, t.description, j.id as entry_id, j.account_code, a.name as account_name, j.debit, j.credit
        FROM transactions t
        JOIN journal_entries j ON t.id = j.transaction_id
        JOIN accounts a ON j.account_code = a.code
        ORDER BY t.date DESC, t.id DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Group by transaction
        const transactions = {};
        rows.forEach(row => {
            if (!transactions[row.id]) {
                transactions[row.id] = {
                    id: row.id,
                    date: row.date,
                    description: row.description,
                    entries: []
                };
            }
            transactions[row.id].entries.push({
                entry_id: row.entry_id,
                account_code: row.account_code,
                account_name: row.account_name,
                debit: row.debit,
                credit: row.credit
            });
        });
        
        res.json(Object.values(transactions));
    });
});

let cachedAccounts = null;
function getAccounts(callback) {
    if (cachedAccounts) return callback(null, cachedAccounts);
    db.all("SELECT * FROM accounts", [], (err, accounts) => {
        if (!err) cachedAccounts = accounts;
        callback(err, accounts);
    });
}

// Process a new transaction using AI
app.post('/api/transaction', (req, res) => {
    const { description } = req.body;
    
    if (!description) {
        return res.status(400).json({ error: "No description provided." });
    }

    // El usuario solicitó que esta Key esté en todos los PCs por defecto
    const API_KEY_FIJA = "AIzaSyAQToL9RLHctLoysQqmnroubL-yIWV5YuM";
    const apiKey = process.env.GEMINI_API_KEY || req.headers['x-api-key'] || API_KEY_FIJA;

    if (!apiKey) {
        return res.status(401).json({ error: "API Key requerida." });
    }

    getAccounts(async (err, accounts) => {
        if (err) return res.status(500).json({ error: err.message });
        
        try {
            const entries = await processAccountingMovement(description, apiKey, accounts);
            
            // Validate double entry logic (A = L + E equivalent)
            const totalDebit = entries.reduce((sum, e) => sum + (e.debit || 0), 0);
            const totalCredit = entries.reduce((sum, e) => sum + (e.credit || 0), 0);
            
            if (totalDebit !== totalCredit || totalDebit === 0) {
                return res.status(400).json({ error: "La partida doble no cuadra o es 0 en la respuesta de la IA.", entries });
            }

            // Save to DB
            const date = new Date().toISOString();
            db.run("INSERT INTO transactions (date, description) VALUES (?, ?)", [date, description], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                const transactionId = this.lastID;
                const stmt = db.prepare("INSERT INTO journal_entries (transaction_id, account_code, debit, credit) VALUES (?, ?, ?, ?)");
                
                entries.forEach(entry => {
                    stmt.run([transactionId, entry.account_code, entry.debit || 0, entry.credit || 0]);
                });
                stmt.finalize();
                
                res.json({ success: true, transactionId, entries });
            });
            
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: e.message || "Error procesando la transacción con IA" });
        }
    });
});

// Process a general accounting question using AI
app.post('/api/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question) {
        return res.status(400).json({ error: "No question provided." });
    }

    const API_KEY_FIJA = "AIzaSyAQToL9RLHctLoysQqmnroubL-yIWV5YuM";
    const apiKey = process.env.GEMINI_API_KEY || req.headers['x-api-key'] || API_KEY_FIJA;

    if (!apiKey) {
        return res.status(401).json({ error: "API Key requerida." });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const { askAccountingQuestionStream } = require('./ai');
        const stream = await askAccountingQuestionStream(question, apiKey);
        
        for await (const chunk of stream) {
            if (chunk.text) {
                res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
            }
        }
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (e) {
        console.error(e);
        res.write(`data: ${JSON.stringify({ error: e.message || "Error procesando la consulta con IA" })}\n\n`);
        res.end();
    }
});

// Update Transaction (Description and Entries)
app.put('/api/transaction/:id', (req, res) => {
    const id = req.params.id;
    const { description, entries } = req.body;
    
    if (!description) return res.status(400).json({ error: "No description provided." });

    if (entries && Array.isArray(entries)) {
        // Validate double entry
        let totalDebit = 0;
        let totalCredit = 0;
        entries.forEach(e => {
            totalDebit += Number(e.debit) || 0;
            totalCredit += Number(e.credit) || 0;
        });

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            return res.status(400).json({ error: `La partida doble no cuadra. Débitos: ${totalDebit}, Créditos: ${totalCredit}` });
        }

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            
            db.run("UPDATE transactions SET description = ? WHERE id = ?", [description, id], function(err) {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
            });

            const stmt = db.prepare("UPDATE journal_entries SET debit = ?, credit = ? WHERE id = ? AND transaction_id = ?");
            entries.forEach(e => {
                stmt.run([Number(e.debit) || 0, Number(e.credit) || 0, e.entry_id, id]);
            });
            stmt.finalize(err => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: err.message });
                }
                db.run("COMMIT");
                res.json({ success: true, id, description });
            });
        });
    } else {
        // Just update description
        db.run("UPDATE transactions SET description = ? WHERE id = ?", [description, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: "Transaction not found." });
            res.json({ success: true, id, description });
        });
    }
});

// Delete Transaction
app.delete('/api/transaction/:id', (req, res) => {
    const id = req.params.id;

    // Delete journal entries first due to foreign key
    db.run("DELETE FROM journal_entries WHERE transaction_id = ?", [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Then delete the transaction
        db.run("DELETE FROM transactions WHERE id = ?", [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: "Transaction not found." });
            res.json({ success: true, deleted_id: id });
        });
    });
});

// Export Ledger to Excel
app.get('/api/export', (req, res) => {
    const query = `
        SELECT t.date as Fecha, t.description as Descripcion, j.account_code as Codigo, a.name as Cuenta, j.debit as Debito, j.credit as Credito
        FROM transactions t
        JOIN journal_entries j ON t.id = j.transaction_id
        JOIN accounts a ON j.account_code = a.code
        ORDER BY t.date ASC, t.id ASC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const worksheet = xlsx.utils.json_to_sheet(rows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Libro Diario");
        
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', 'attachment; filename="libro_diario.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

// Generate Booking Report PDF using PDFKit (Word-Style with Highlights)
app.post('/api/generate-booking-report', async (req, res) => {
    try {
        const data = req.body;
        const doc = new PDFDocument({ margin: 70, size: 'A4', bufferPages: true });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Reserva_${data.nombreReserva.replace(/ /g, '_')}.pdf"`);
        doc.pipe(res);

        const format = (v) => `$ ${parseFloat(v || 0).toLocaleString('es-CO')}`;
        const footerColor = '#6d28d9'; // Purple/Blue from screenshot
        const footerText = 'Calle 32 32-64 local 11 CC. Riviera Plaza Bucaramanga 3167583928-3165791058-6076744033';

        // Helper to draw highlighted text
        const highlight = (text, x, y, isBold = true) => {
            doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
            const width = doc.widthOfString(text);
            const height = 12; // Adjusted for 10pt font
            doc.save()
               .rect(x, y - 1, width + 4, height)
               .fill('#ffff00'); // Yellow
            doc.fillColor('#000000').text(text, x + 2, y);
            doc.restore();
            return width + 10;
        };

        const addFooter = () => {
            doc.fontSize(8).fillColor(footerColor).text(footerText, 50, 780, { align: 'center' });
        };

        doc.on('pageAdded', addFooter);

        // --- PAGE 1: BASIC INFO ---
        const logoPath = path.join(__dirname, 'public', 'report_logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, (doc.page.width - 120) / 2, 40, { width: 120 });
        }

        doc.moveDown(6);
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12).text('INFORME DE SU RESERVA', { align: 'center' });
        doc.moveDown(1.5);

        let currentY = doc.y;
        doc.font('Helvetica').fontSize(10).text('Fecha de la Reserva: ', 70, currentY, { continued: true });
        highlight(`${data.fechaReserva} de 2026`, doc.x, currentY);

        currentY += 25;
        doc.text('Nombre de la Reserva: ', 70, currentY, { continued: true });
        let nextX = doc.x + highlight(data.nombreReserva, doc.x, currentY);
        doc.text(' C.C : ', nextX, currentY, { continued: true });
        highlight(data.ccReserva, doc.x, currentY);

        currentY += 25;
        doc.text('Personas: ', 70, currentY, { continued: true });
        highlight(data.personas, doc.x, currentY);

        currentY += 25;
        doc.font('Helvetica-Bold').text('CODIGO DE LA RESERVA: ', 70, currentY, { continued: true });
        highlight(data.codigoReserva, doc.x, currentY);

        currentY += 25;
        doc.font('Helvetica').text('Dirección del inmueble: ', 70, currentY, { continued: true });
        highlight(data.direccionInmueble, doc.x, currentY);

        currentY += 25;
        doc.text('Entrada: ', 70, currentY, { continued: true });
        highlight(`${data.entrada} DE 2026`, doc.x, currentY);

        currentY += 25;
        doc.text('Salida: ', 70, currentY, { continued: true });
        highlight(`${data.salida} DE 2026`, doc.x, currentY);

        currentY += 25;
        doc.text('Valor noche Adicional: ', 70, currentY, { continued: true });
        highlight(format(data.valorNocheAdicional), doc.x, currentY);

        currentY += 25;
        doc.text('Valor total del Arriendo mensual: ', 70, currentY, { continued: true });
        highlight(format(data.valorTotalArriendo), doc.x, currentY);

        addFooter();

        // --- PAGE 2: FINANCIALS ---
        doc.addPage();
        if (fs.existsSync(logoPath)) doc.image(logoPath, (doc.page.width - 80) / 2, 40, { width: 80 });
        doc.moveDown(6);

        currentY = doc.y;
        doc.font('Helvetica-Bold').text('BONO REMBOLSABLE: ', 70, currentY, { continued: true });
        highlight(format(data.bonoReembolsable), doc.x, currentY);
        doc.text(' por pérdidas o daños. ', doc.x, currentY);

        currentY += 25;
        doc.text('Aseo: ', 70, currentY, { continued: true });
        highlight(format(data.aseo), doc.x, currentY);

        const arriendo = parseFloat(data.valorTotalArriendo || 0);
        const aseo = parseFloat(data.aseo || 0);
        const bono = parseFloat(data.bonoReembolsable || 0);
        const total = arriendo + aseo + bono;
        const reserva30 = Math.round(total * 0.3);
        const saldo = total - reserva30;

        currentY += 25;
        doc.text('Total: ', 70, currentY, { continued: true });
        highlight(format(total), doc.x, currentY);

        currentY += 40;
        doc.text('Valor para reservación (30% del total) ', 70, currentY, { continued: true });
        highlight(format(reserva30), doc.x, currentY);

        currentY += 25;
        doc.text('Saldo al entrar al apartamento: ', 70, currentY, { continued: true });
        highlight(format(saldo), doc.x, currentY);

        currentY += 25;
        doc.font('Helvetica').text('De los cuales ', 70, currentY, { continued: true });
        highlight(format(bono), doc.x, currentY);
        doc.text(' son reembolsables al revisar el inventario y este al dia. ', doc.x, currentY);

        doc.moveDown(2);
        doc.font('Helvetica').fontSize(9).text('La comisión de la consignación cobrada por el banco deberá ser paga por el huésped', { align: 'left', indent: 20 });
        doc.text('En el momento de la llegada se debe cancelar la totalidad del dinero.', { align: 'left', indent: 20 });
        doc.text(`Todas las propiedades tienen una tarifa de limpieza de COP `, { continued: true, indent: 20 });
        highlight(format(aseo), doc.x, doc.y - 2);
        doc.text('. Esta tarifa No está incluida en el valor del alquiler y se paga una sola vez por la propiedad (no es por persona ni por noche).', doc.x, doc.y - 2);

        // --- PAGE 3: LEGAL 1 ---
        doc.addPage();
        if (fs.existsSync(logoPath)) doc.image(logoPath, (doc.page.width - 80) / 2, 40, { width: 80 });
        doc.moveDown(6);
        
        doc.fontSize(10).font('Helvetica').text('Contamos con seguro médico en caso de accidente o enfermedad que ocurra dentro del inmueble. Pregúntame cómo obtenerlo', { align: 'justify' });
        doc.moveDown();
        doc.text('El ingreso de un número de personas mayor a las autorizadas, genera incumplimiento del contrato. Por tanto, se podrá dar por cancelado el mismo sin devolución alguna del dinero recibido. En caso de autorizarse, el valor por persona extra es de $50.000 DIARIO', { align: 'justify' });
        doc.moveDown();
        doc.text('El valor del depósito se reintegra cuando el propietario revise el inventario En contratos celebrados a meses, el depósito será devuelto 60 días después de la salida', { align: 'justify' });
        doc.moveDown();
        doc.text('Hora de entrada (check in): 3:00 PM', { continued: true });
        doc.text(' | Hora de salida (check out): 12:00 PM');

        doc.moveDown(2);
        doc.font('Helvetica-Bold').text('CLÁUSULA X — POLÍTICAS DE CANCELACIÓN, REEMBOLSO Y CONDICIONES DE ENTREGA DEL INMUEBLE');
        doc.font('Helvetica').text('En el momento en que se realiza la reserva, el apartamento se retira de la plataforma lo que impide que pueda ser tomado por otras personas. Por esta razón, el inmueble pierde la posibilidad de volver a ofrecerse y, en consecuencia, el 30% pagado por concepto de reserva no es reembolsable.', { align: 'justify' });
        
        doc.moveDown();
        doc.font('Helvetica-Bold').text('CONDICIONES DE PAGO PREVIO AL INGRESO');
        doc.font('Helvetica').text('El arrendatario deberá cancelar el cien por ciento (100%) del valor total del alojamiento a más tardar el día de la entrega del apto. En caso contrario, no se entregarán las llaves del inmueble.', { align: 'justify' });

        // --- PAGE 4: LEGAL 2 ---
        doc.addPage();
        if (fs.existsSync(logoPath)) doc.image(logoPath, (doc.page.width - 80) / 2, 40, { width: 80 });
        doc.moveDown(6);

        doc.font('Helvetica-Bold').text('DOCUMENTACIÓN OBLIGATORIA PARA LA ENTREGA DEL INMUEBLE');
        doc.font('Helvetica').text('El arrendatario deberá suscribir y entregar, en original y copia, los siguientes documentos: Acepta términos y condiciones https: rentahouse01@hotmail.com-rentahouse@gmail.com', { align: 'justify' });
        
        doc.moveDown(2);
        doc.font('Helvetica-Bold').text('Aceptación de las Condiciones');
        doc.font('Helvetica').text('El ARRENDATARIO declara haber leído, comprendido y aceptado esta cláusula como parte integral del contrato de arrendamiento temporal celebrado con ALQUILER RENTA HOUSE', { align: 'justify' });

        doc.moveDown(2);
        doc.font('Helvetica-Bold').text('4. Aceptación por Silencio del Arrendatario');
        doc.font('Helvetica').text('Una vez ALQUILER RENTA HOUSE envíe al ARRENDATARIO el contrato, anexos, inventarios o cualquier información relacionada con el alojamiento, a través de WhatsApp, correo electrónico u otro medio autorizado, y no exista respuesta u objeción dentro de un plazo máximo de veinticuatro (24) horas, se entenderá que el ARRENDATARIO acepta en su totalidad el contenido enviado.', { align: 'justify' });

        // --- PAGE 5: PAYMENT ---
        doc.addPage();
        if (fs.existsSync(logoPath)) doc.image(logoPath, (doc.page.width - 80) / 2, 40, { width: 80 });
        doc.moveDown(6);

        doc.font('Helvetica-Bold').fontSize(11).text('METODO DE PAGO');
        doc.moveDown(0.5);
        highlight(data.metodoPago || 'TRANSFERENCIA BANCARIA', 70, doc.y);
        doc.moveDown(2);
        doc.font('Helvetica').text('Calle 32 # 32 – 64 Local 11 Centro Comercial Riviera Plaza Bucaramanga.');
        doc.font('Helvetica-Bold').text('TRANSFERENCIA O CONSIGNACIÓN');
        doc.text('BANCOLOMBIA CUENTA DE AHORROS # 02046147939');

        doc.fontSize(7).fillColor('#cbd5e1').text('Desarrollado por Juan Duarte para Alquiler Renta House', 50, 780, { align: 'right' });

        doc.end();
        console.log('Word-Style PDF with highlights generated');

    } catch (error) {
        console.error('Error in PDF generation:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Error: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
