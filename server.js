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

// Generate Booking Report PDF using PDFKit (100% Reliable)
app.post('/api/generate-booking-report', async (req, res) => {
    try {
        const data = req.body;
        const doc = new PDFDocument({ margin: 50, size: 'A4' });

        // Stream PDF to response
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Reserva_${data.nombreReserva.replace(/ /g, '_')}.pdf"`);
        doc.pipe(res);

        // --- Header Section ---
        const logoPath = path.join(__dirname, 'public', 'report_logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, 45, { width: 140 });
        }

        doc.fillColor('#0f172a')
           .font('Helvetica-Bold')
           .fontSize(22)
           .text('INFORME DE SU RESERVA', 0, 60, { align: 'center' });

        doc.fontSize(10)
           .font('Helvetica')
           .text(`Fecha de la Reserva: ${data.fechaReserva} de 2026`, 200, 95, { align: 'right' });

        doc.moveDown(4);

        // --- Data Grid Section ---
        const startY = 160;
        const rowHeight = 25;
        const labelX = 70;
        const valueX = 250;

        const drawRow = (label, value, y, isTotal = false) => {
            if (isTotal) {
                doc.rect(50, y - 5, 500, rowHeight).fill('#f1f5f9');
                doc.fillColor('#0f172a').font('Helvetica-Bold');
            } else {
                doc.fillColor('#475569').font('Helvetica');
            }
            doc.text(label, labelX, y);
            doc.fillColor('#0f172a').font('Helvetica-Bold').text(value, valueX, y);
        };

        let currentY = startY;
        drawRow('Nombre de la Reserva:', data.nombreReserva, currentY); currentY += rowHeight;
        drawRow('C.C. / ID:', data.ccReserva, currentY); currentY += rowHeight;
        drawRow('Personas:', data.personas, currentY); currentY += rowHeight;
        drawRow('CÓDIGO DE LA RESERVA:', data.codigoReserva, currentY); currentY += rowHeight;
        drawRow('Dirección del inmueble:', data.direccionInmueble, currentY); currentY += rowHeight;
        drawRow('Entrada:', data.entrada, currentY); currentY += rowHeight;
        drawRow('Salida:', data.salida, currentY); currentY += rowHeight;
        
        doc.moveDown();
        currentY += 10;

        const format = (v) => `$ ${parseFloat(v || 0).toLocaleString('es-CO')}`;

        drawRow('Valor noche Adicional:', format(data.valorNocheAdicional), currentY); currentY += rowHeight;
        drawRow('Valor total del Arriendo:', format(data.valorTotalArriendo), currentY); currentY += rowHeight;
        drawRow('BONO REEMBOLSABLE:', format(data.bonoReembolsable), currentY); currentY += rowHeight;
        drawRow('Aseo:', format(data.aseo), currentY); currentY += rowHeight;

        // Calculations
        const total = parseFloat(data.valorTotalArriendo || 0) + parseFloat(data.aseo || 0);
        const reserva30 = Math.round(total * 0.3);
        const saldoAlEntrar = total - reserva30;

        doc.moveDown();
        currentY += 10;
        drawRow('TOTAL:', format(total), currentY, true); currentY += rowHeight + 5;
        drawRow('Valor para reservación (30%):', format(reserva30), currentY); currentY += rowHeight;
        drawRow('Saldo al entrar al apartamento:', format(saldoAlEntrar), currentY); currentY += rowHeight;

        doc.moveDown(2);
        
        // --- Footer/Clauses Section ---
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b');
        doc.text('La comisión de la consignación cobrada por el banco deberá ser paga por el huésped.', { align: 'center' });
        doc.text('En el momento de la llegada se debe cancelar la totalidad del dinero.', { align: 'center' });
        
        doc.moveDown();
        doc.font('Helvetica-Bold').fillColor('#0f172a');
        doc.text('MÉTODO DE PAGO:', { underline: true });
        doc.font('Helvetica').text(data.metodoPago || 'No especificado');

        doc.moveDown(2);
        doc.fontSize(8).fillColor('#94a3b8').text('Calle 32 32-64 local 11 CC. Riviera Plaza Bucaramanga', { align: 'center' });

        // --- Developers Credits in PDF ---
        doc.fontSize(7).fillColor('#cbd5e1').text('Desarrollado por Juan Duarte para Alquiler Renta House', 50, 780, { align: 'right' });

        doc.end();
        console.log('PDF generated successfully with PDFKit');

    } catch (error) {
        console.error('Error generating PDF with PDFKit:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error al generar el PDF: ' + error.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
