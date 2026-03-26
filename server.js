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

// Generate Booking Report PDF using PDFKit (Full Structure)
app.post('/api/generate-booking-report', async (req, res) => {
    try {
        const data = req.body;
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

        // Stream PDF to response
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Contrato_${data.nombreReserva.replace(/ /g, '_')}.pdf"`);
        doc.pipe(res);

        const format = (v) => `$ ${parseFloat(v || 0).toLocaleString('es-CO')}`;
        const footerText = 'Calle 32 32-64 local 11 CC. Riviera Plaza Bucaramanga | 3167583928 - 3165791058 - 6076744033';

        // Helper for Footer on every page
        doc.on('pageAdded', () => {
            doc.fontSize(8).fillColor('#94a3b8').text(footerText, 50, 780, { align: 'center' });
        });

        // --- PAGE 1: HEADER & RESERVATION DATA ---
        const logoPath = path.join(__dirname, 'public', 'report_logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, 45, { width: 140 });
        }

        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(20).text('INFORME DE SU RESERVA', 0, 60, { align: 'center' });
        doc.fontSize(10).font('Helvetica').text(`Fecha de la Reserva: ${data.fechaReserva} de 2026`, 200, 95, { align: 'right' });

        doc.moveDown(4);

        const drawInfoRow = (label, value, y) => {
            doc.fillColor('#475569').font('Helvetica').fontSize(10).text(label, 70, y);
            doc.fillColor('#0f172a').font('Helvetica-Bold').text(value, 230, y);
        };

        let y = 160;
        const step = 22;
        drawInfoRow('Nombre de la Reserva:', data.nombreReserva, y); y += step;
        drawInfoRow('C.C / ID:', data.ccReserva, y); y += step;
        drawInfoRow('Personas:', data.personas, y); y += step;
        drawInfoRow('CÓDIGO DE LA RESERVA:', data.codigoReserva, y); y += step;
        drawInfoRow('Dirección del inmueble:', data.direccionInmueble, y); y += step;
        drawInfoRow('Entrada:', `${data.entrada} de 2026`, y); y += step;
        drawInfoRow('Salida:', `${data.salida} de 2026`, y); y += step;
        drawInfoRow('Valor noche Adicional:', format(data.valorNocheAdicional), y); y += step;
        drawInfoRow('Valor Arriendo mensual:', format(data.valorTotalArriendo), y); y += step * 1.5;

        // Financials Highlights
        doc.rect(50, y, 500, 110).fill('#f8fafc');
        doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(11);
        y += 10;
        doc.text(`BONO REEMBOLSABLE:`, 70, y); doc.text(format(data.bonoReembolsable), 350, y); y += step;
        doc.fontSize(9).font('Helvetica-Oblique').text('(Por pérdidas o daños)', 70, y - 5); y += 10;
        doc.fontSize(11).font('Helvetica-Bold').text(`ASEO:`, 70, y); doc.text(format(data.aseo), 350, y); y += step;
        
        const total = parseFloat(data.valorTotalArriendo || 0) + parseFloat(data.aseo || 0);
        const reserva30 = Math.round(total * 0.3);
        const saldoAlEntrar = total - reserva30;

        doc.fillColor('#2563eb').text(`TOTAL:`, 70, y); doc.text(format(total), 350, y); y += step + 5;
        
        doc.fillColor('#1e293b').fontSize(10);
        doc.text(`Valor para reservación (30%):`, 70, y); doc.text(format(reserva30), 350, y); y += step;
        doc.rect(50, y - 5, 500, 25).fill('#e2e8f0');
        doc.fillColor('#0f172a').font('Helvetica-Bold').text(`Saldo al entrar al apartamento:`, 70, y); doc.text(format(saldoAlEntrar), 350, y);
        y += step + 10;

        doc.font('Helvetica').fontSize(9).fillColor('#475569');
        doc.text(`De los cuales $ ${parseFloat(data.bonoReembolsable || 0).toLocaleString('es-CO')} son reembolsables al revisar el inventario y este al dia.`, 50, y + 10, { align: 'center' });
        
        doc.moveDown(2);
        doc.fontSize(9).fillColor('#64748b').font('Helvetica-Oblique');
        doc.text('La comisión de la consignación cobrada por el banco deberá ser paga por el huésped.', { align: 'center' });
        doc.text('En el momento de la llegada se debe cancelar la totalidad del dinero.', { align: 'center' });
        doc.text(`Todas las propiedades tienen una tarifa de limpieza de ${format(data.aseo)}. Esta tarifa No está incluida en el valor del alquiler y se paga una sola vez por la propiedad.`, { align: 'center' });

        // --- FOOTER PAGE 1 ---
        doc.fontSize(8).fillColor('#94a3b8').text(footerText, 50, 780, { align: 'center' });

        // --- PAGE 2: CLAUSES & POLICIES ---
        doc.addPage();
        y = 50;
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text('CONDICIONES ADICIONALES Y POLÍTICAS', 50, y);
        y += 30;

        const bodyFont = { font: 'Helvetica', size: 10, color: '#334155' };
        const boldFont = { font: 'Helvetica-Bold', size: 10, color: '#0f172a' };

        const addBullet = (text, isBold = false) => {
            doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(isBold ? '#0f172a' : '#334155');
            doc.text(`• ${text}`, 60, y, { width: 480, align: 'justify' });
            y += doc.heightOfString(`• ${text}`, { width: 480 }) + 8;
        };

        addBullet('Contamos con seguro médico en caso de accidente o enfermedad que ocurra dentro del inmueble. Pregúntame cómo obtenerlo.');
        addBullet('El ingreso de un número de personas mayor a las autorizadas, genera incumplimiento del contrato. Por tanto, se podrá dar por cancelado el mismo sin devolución alguna del dinero recibido. En caso de autorizarse, el valor por persona extra es de $50.000 DIARIO.', true);
        addBullet('El valor del depósito se reintegra cuando el propietario revise el inventario. En contratos celebrados a meses, el depósito será devuelto 60 días después de la salida.');
        addBullet('Hora de entrada (check in): 3:00 PM | Hora de salida (check out): 12:00 PM', true);

        y += 20;
        doc.font('Helvetica-Bold').fontSize(11).text('CLÁUSULA X — POLÍTICAS DE CANCELACIÓN Y REEMBOLSO', 50, y);
        y += 20;
        doc.font('Helvetica').fontSize(10).fillColor('#334155').text('En el momento en que se realiza la reserva, el apartamento se retira de la plataforma lo que impide que pueda ser tomado por otras personas. Por esta razón, el inmueble pierde la posibilidad de volver a ofrecerse y, en consecuencia, el 30% pagado por concepto de reserva no es reembolsable.', 50, y, { width: 500, align: 'justify' });
        y += 60;

        doc.font('Helvetica-Bold').text('CONDICIONES DE PAGO PREVIO AL INGRESO', 50, y);
        y += 15;
        doc.font('Helvetica').text('El arrendatario deberá cancelar el cien por ciento (100%) del valor total del alojamiento a más tardar el día de la entrega del apto. En caso contrario, no se entregarán las llaves del inmueble.', 50, y, { width: 500 });
        y += 45;

        doc.font('Helvetica-Bold').text('DOCUMENTACIÓN OBLIGATORIA', 50, y);
        y += 15;
        doc.font('Helvetica').text('El arrendatario deberá suscribir y entregar, en original y copia, los siguientes documentos: Acepta términos y condiciones en rentahouse01@hotmail.com / rentahouse@gmail.com', 50, y, { width: 500 });
        
        // --- PAGE 3: ACCEPTANCE & BANK INFO ---
        doc.addPage();
        y = 50;
        doc.font('Helvetica-Bold').fontSize(11).text('ACEPTACIÓN DE LAS CONDICIONES', 50, y);
        y += 20;
        doc.font('Helvetica').fontSize(10).text('El ARRENDATARIO declara haber leído, comprendido y aceptado esta cláusula como parte integral del contrato de arrendamiento temporal celebrado con ALQUILER RENTA HOUSE.', 50, y, { width: 500 });
        y += 45;

        doc.font('Helvetica-Bold').text('4. ACEPTACIÓN POR SILENCIO DEL ARRENDATARIO', 50, y);
        y += 20;
        doc.font('Helvetica').text('Una vez ALQUILER RENTA HOUSE envíe al ARRENDATARIO el contrato, anexos, inventarios o cualquier información relacionada con el alojamiento, a través de WhatsApp, correo electrónico u otro medio autorizado, y no exista respuesta u objeción dentro de un plazo máximo de veinticuatro (24) horas, se entenderá que el ARRENDATARIO acepta en su totalidad el contenido enviado.', 50, y, { width: 500, align: 'justify' });
        y += 65;
        doc.text('La falta de respuesta se interpretará como consentimiento tácito, dado que la información fue remitida al medio de contacto registrado.', 50, y, { width: 500 });
        
        y += 60;
        doc.rect(50, y, 500, 100).strokeColor('#cbd5e1').stroke();
        doc.font('Helvetica-Bold').fontSize(11).text('MÉTODO DE PAGO Y TRANSFERENCIA', 65, y + 15);
        doc.font('Helvetica').fontSize(10).text(`BANCOLOMBIA CUENTA DE AHORROS # 02046147939`, 65, y + 35);
        doc.text(`Titular: ALQUILER RENTA HOUSE`, 65, y + 50);
        doc.font('Helvetica-Bold').text(`Referencia de pago: ${data.metodoPago}`, 65, y + 70);

        // Final credits
        doc.fontSize(7).fillColor('#cbd5e1').text('Desarrollado por Juan Duarte para Alquiler Renta House', 50, 780, { align: 'right' });

        doc.end();
        console.log('Full Contract PDF generated successfully');

    } catch (error) {
        console.error('Error in PDF generation:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error al generar el PDF: ' + error.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
