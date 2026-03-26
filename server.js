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

// Generate Booking Report PDF using PDFKit (Full Structure & Aesthetic)
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
        const brandColor = '#1e3a8a'; // Navy Blue
        const secondaryColor = '#475569'; // Slate Gray

        // Helper for Footer on every page
        doc.on('pageAdded', () => {
            doc.fontSize(8).fillColor('#94a3b8').text(footerText, 50, 780, { align: 'center' });
        });

        // --- PAGE 1: HEADER & RESERVATION DATA ---
        const logoPath = path.join(__dirname, 'public', 'report_logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, 45, { width: 140 });
        }

        doc.fillColor(brandColor).font('Helvetica-Bold').fontSize(22).text('INFORME DE SU RESERVA', 0, 70, { align: 'center' });
        doc.fontSize(10).font('Helvetica').fillColor(secondaryColor).text(`Fecha de la Reserva: ${data.fechaReserva} de 2026`, 50, 110, { align: 'right' });

        doc.moveTo(50, 130).lineTo(545, 130).strokeColor('#e2e8f0').lineWidth(1).stroke();

        doc.moveDown(4);

        const drawInfoRow = (label, value, y) => {
            doc.fillColor(secondaryColor).font('Helvetica').fontSize(10).text(label, 70, y);
            doc.fillColor('#0f172a').font('Helvetica-Bold').text(value, 230, y);
        };

        let y = 160;
        const step = 24;
        drawInfoRow('Nombre de la Reserva:', data.nombreReserva, y); y += step;
        drawInfoRow('C.C / ID:', data.ccReserva, y); y += step;
        drawInfoRow('Personas:', data.personas, y); y += step;
        drawInfoRow('CÓDIGO DE LA RESERVA:', data.codigoReserva, y); y += step;
        drawInfoRow('Dirección del inmueble:', data.direccionInmueble, y); y += step;
        drawInfoRow('Entrada:', `${data.entrada} de 2026`, y); y += step;
        drawInfoRow('Salida:', `${data.salida} de 2026`, y); y += step;
        drawInfoRow('Valor noche Adicional:', format(data.valorNocheAdicional), y); y += step;

        doc.moveDown(1);
        y += 10;
        doc.moveTo(70, y).lineTo(525, y).strokeColor('#f1f5f9').lineWidth(0.5).stroke();
        y += 15;

        // Financials Highlights (Updated Calculation)
        const arriendo = parseFloat(data.valorTotalArriendo || 0);
        const aseo = parseFloat(data.aseo || 0);
        const bono = parseFloat(data.bonoReembolsable || 0);
        
        // TOTAL includes Arriendo + Aseo + Bono Reembolsable
        const total = arriendo + aseo + bono;
        const reserva30 = Math.round(total * 0.3); // 30% includes the deposit too now
        const saldoAlEntrar = total - reserva30;

        drawInfoRow('Valor Arriendo:', format(arriendo), y); y += step;
        drawInfoRow('Aseo:', format(aseo), y); y += step;
        drawInfoRow('BONO REEMBOLSABLE:', format(bono), y); y += step;

        y += 10;
        doc.rect(50, y, 500, 85).fill('#f8fafc');
        doc.rect(50, y, 5, 85).fill(brandColor); // Decorative side bar
        
        y += 15;
        doc.fillColor(brandColor).font('Helvetica-Bold').fontSize(14);
        doc.text(`TOTAL GENERAL:`, 70, y); doc.text(format(total), 350, y); y += step + 2;
        
        doc.fillColor(secondaryColor).font('Helvetica').fontSize(11);
        doc.text(`Reserva para separación (30%):`, 70, y); doc.fillColor('#0f172a').text(format(reserva30), 350, y); y += step;
        
        doc.fillColor(secondaryColor).text(`Saldo pendiente al ingresar:`, 70, y); doc.fillColor('#0f172a').text(format(saldoAlEntrar), 350, y);
        y += step + 20;

        doc.font('Helvetica-Oblique').fontSize(9).fillColor(secondaryColor);
        doc.text(`* El bono de $ ${parseFloat(bono).toLocaleString('es-CO')} es reembolsable tras revisar el inventario.`, 50, y, { align: 'center' });
        
        doc.moveDown(1);
        doc.fontSize(8).fillColor('#64748b').font('Helvetica');
        const notes = [
            'La comisión bancaria por consignación deberá ser cubierta por el huésped.',
            'La totalidad del saldo pendiente debe cancelarse al momento de la llegada.',
            `Tarifa de aseo única por estadía: ${format(aseo)} (No incluida en el valor noche).`
        ];
        notes.forEach(note => doc.text(note, { align: 'center' }));

        // --- FOOTER PAGE 1 ---
        doc.fontSize(8).fillColor('#94a3b8').text(footerText, 50, 780, { align: 'center' });

        // --- PAGE 2: CLAUSES & POLICIES ---
        doc.addPage();
        y = 50;
        doc.fillColor(brandColor).font('Helvetica-Bold').fontSize(14).text('CLÁUSULAS Y POLÍTICAS DE RESERVA', 50, y);
        doc.moveTo(50, y + 20).lineTo(250, y + 20).strokeColor(brandColor).lineWidth(2).stroke();
        y += 40;

        const addAestheticBullet = (text, isBold = false) => {
            doc.circle(65, y + 5, 3).fill(brandColor);
            doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(isBold ? '#0f172a' : '#334155');
            doc.text(text, 80, y, { width: 460, align: 'justify' });
            y += doc.heightOfString(text, { width: 460 }) + 10;
        };

        addAestheticBullet('Seguro médico: Contamos con cobertura en caso de accidente o enfermedad dentro del inmueble. Consulte condiciones.');
        addAestheticBullet('Personas extras: El ingreso de más personas de las autorizadas genera incumplimiento. El valor por persona extra por día es de $50.000.', true);
        addAestheticBullet('Devolución de depósito: Se reintegra tras revisión de inventario. En contratos mensuales, la devolución será 60 días tras la salida.');
        addAestheticBullet('Horarios: Check-in a las 3:00 PM | Check-out a las 12:00 PM', true);

        y += 15;
        doc.font('Helvetica-Bold').fontSize(11).fillColor(brandColor).text('POLÍTICAS DE CANCELACIÓN', 50, y);
        y += 15;
        doc.font('Helvetica').fontSize(9.5).fillColor('#475569').text('Al reservar, el inmueble se retira de la oferta comercial. Por tal motivo, el 30% abonado NO ES REEMBOLSABLE ya que compensa la pérdida de oportunidad de alquiler con otros clientes.', 50, y, { width: 500, align: 'justify' });
        y += 45;

        doc.rect(50, y, 500, 45).strokeColor('#e2e8f0').stroke();
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('PAGO PREVIO AL INGRESO', 60, y + 10);
        doc.font('Helvetica').fontSize(9).text('Debe cancelar el 100% del valor antes o durante la entrega. No se entregarán llaves sin el pago total.', 60, y + 25);
        y += 65;

        doc.fillColor(brandColor).font('Helvetica-Bold').text('DOCUMENTACIÓN OBLIGATORIA', 50, y);
        y += 15;
        doc.font('Helvetica').fontSize(9.5).fillColor('#475569').text('El arrendatario debe entregar copia de documentos y haber aceptado términos en: rentahouse01@hotmail.com / rentahouse@gmail.com', 50, y, { width: 500 });
        
        // --- PAGE 3: ACCEPTANCE & BANK INFO ---
        doc.addPage();
        y = 50;
        doc.fillColor(brandColor).font('Helvetica-Bold').fontSize(14).text('DECLARACIÓN DE ACEPTACIÓN', 50, y);
        y += 30;
        doc.font('Helvetica').fontSize(10).fillColor('#334155').text('El ARRENDATARIO declara haber leído, comprendido y aceptado todas las condiciones de este contrato simplificado celebrado con ALQUILER RENTA HOUSE.', 50, y, { width: 500 });
        y += 45;

        doc.font('Helvetica-Bold').text('ACEPTACIÓN POR SILENCIO (24 HORAS)', 50, y);
        y += 20;
        doc.font('Helvetica').fontSize(9.5).text('Si transcurridas 24 horas desde el envío de esta información por WhatsApp o correo no existe objeción, se entenderá aceptada en su totalidad.', 50, y, { width: 500, align: 'justify' });
        
        y += 100;
        // Modern Payment Box
        doc.rect(50, y, 500, 130).fill('#1e3a8a');
        y += 15;
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14).text('INSTRUCCIONES DE CANCELACIÓN (PAGO)', 70, y);
        y += 25;
        doc.fontSize(12).text('BANCOLOMBIA - CUENTA DE AHORROS', 70, y);
        y += 18;
        doc.fontSize(16).text('# 02046147939', 70, y);
        y += 22;
        doc.fontSize(10).font('Helvetica').text('A nombre de: ALQUILER RENTA HOUSE', 70, y);
        y += 15;
        doc.text(`Referencia para su envío: ${data.metodoPago || data.nombreReserva}`, 70, y);

        // Final credits
        doc.fontSize(7).fillColor('#cbd5e1').text('Desarrollado por Juan Duarte para Alquiler Renta House', 50, 780, { align: 'right' });

        doc.end();
        console.log('Premium PDF generated successfully');

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
