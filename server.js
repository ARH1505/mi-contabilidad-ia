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

// Generate Booking Report PDF using PDFKit (Exact Literal Text - Compact Final)
app.post('/api/generate-booking-report', async (req, res) => {
    try {
        const data = req.body || {};
        const nombreReserva = (data.nombreReserva || 'Reserva').replace(/[/\\?%*:|"<>]/g, '-');
        
        // Slightly larger content area
        const doc = new PDFDocument({ margin: 60, size: 'A4', bufferPages: true });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Reserva_${nombreReserva}.pdf"`);
        doc.pipe(res);

        const format = (v) => `$ ${parseFloat(v || 0).toLocaleString('es-CO')}`;
        const footerColor = '#6d28d9';
        const footerText = 'Calle 32 32-64 local 11 CC. Riviera Plaza Bucaramanga | 3167583928 - 3165791058';
        const MARGIN_X = 60;

        // Header Logo
        const logoPath = path.join(__dirname, 'public', 'report_logo.png');
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, MARGIN_X, 30, { width: 90 });
        }
        doc.moveDown(4);

        // Title
        doc.font('Helvetica-Bold').fontSize(13).text('INFORME DE SU RESERVA', MARGIN_X, doc.y, { align: 'center' });
        doc.moveDown(0.8);

        const drawLine = (label, value) => {
            doc.font('Helvetica').fontSize(8.5).fillColor('#000000').text(label, MARGIN_X, doc.y, { continued: true });
            doc.font('Helvetica-Bold').text(String(value || ''));
            doc.moveDown(0.15);
        };

        // --- INFO ---
        drawLine('Fecha de la Reserva: ', `${data.fechaReserva || ''} de 2026`);
        drawLine('Nombre de la Reserva: ', `${data.nombreReserva || ''}    C.C : ${data.ccReserva || ''}`);
        drawLine('Personas: ', data.personas);
        drawLine('CODIGO DE LA RESERVA: ', data.codigoReserva);
        drawLine('Dirección del inmueble: ', data.direccionInmueble);
        drawLine('Entrada: ', `${data.entrada || ''} DE 2026`);
        drawLine('Salida: ', `${data.salida || ''} DE 2026`);
        drawLine('Valor noche Adicional: ', format(data.valorNocheAdicional));
        drawLine('Valor total del Arriendo mensual: ', format(data.valorTotalArriendo));
        
        doc.moveDown(0.3);
        drawLine('BONO REMBOLSABLE: ', `${format(data.bonoReembolsable)} por pérdidas o daños.`);
        drawLine('Aseo: ', format(data.aseo));
        
        const total = parseFloat(data.valorTotalArriendo || 0) + parseFloat(data.aseo || 0) + parseFloat(data.bonoReembolsable || 0);
        const res30 = Math.round(total * 0.3);
        const saldo = total - res30;

        drawLine('Total: ', format(total));
        drawLine('Valor para reservación (30% del total) ', format(res30));
        drawLine('Saldo al entrar al apartamento: ', format(saldo));
        
        doc.font('Helvetica').fontSize(8.5).text(`De los cuales `, { continued: true });
        doc.font('Helvetica-Bold').text(`${format(data.bonoReembolsable)}`, { continued: true });
        doc.font('Helvetica').text(` son reembolsables al revisar el inventario y este al dia.`);

        doc.moveDown(0.3);
        doc.fontSize(8).text('• La comisión de la consignación bancaria debe ser paga por el huésped.');
        doc.text('• Al momento de la llegada se debe cancelar la totalidad del dinero.');
        doc.text(`• Tarifa de limpieza única: ${format(data.aseo)}. No incluida en el alquiler (se paga una vez).`);

        doc.moveDown(0.8);

        // --- LEGAL (Compact) ---
        doc.fontSize(8).text('Seguro médico incluido en caso de accidente. El ingreso de personas extra genera incumplimiento ($50.000 diarios). El depósito se reintegra tras revisión de inventario (hasta 60 días para meses).', { align: 'justify' });
        doc.font('Helvetica-Bold').text('Check-in: 3:00 PM | Check-out: 12:00 PM');

        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').text('POLÍTICAS DE CANCELACIÓN Y ENTREGA');
        doc.font('Helvetica').text('El 30% de reserva no es reembolsable. El huésped debe cancelar el 100% a más tardar el día de la entrega (o no se darán llaves). Documentación obligatoria enviada a rentahouse01@hotmail.com.', { align: 'justify' });

        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').text('ACEPTACIÓN');
        doc.font('Helvetica').text('El ARRENDATARIO acepta todas las condiciones de este contrato simplificado. El silencio por 24 horas tras el envío de este documento constituye consentimiento tácito y aceptación total.', { align: 'justify' });

        doc.moveDown(1.5);
        doc.font('Helvetica-Bold').fontSize(10).text('METODO DE PAGO');
        doc.font('Helvetica').fontSize(8.5).text(data.metodoPago || 'Bancolombia Ahorros #02046147939');
        doc.text('Calle 32 # 32 – 64 Local 11 Centro Comercial Riviera Plaza Bucaramanga.');
        doc.font('Helvetica-Bold').text('ALQUILER RENTA HOUSE');

        // Footers logic - CRITICAL: Check if page has content
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            
            // If doc.y is still at the top (60) or near it, the page is likely a ghost page
            // But usually, if it's the last page and doc.y < 80, it's empty.
            if (i === range.start + range.count - 1 && doc.y < 80) {
                // Skip empty last page footer (and it won't be seen if no text is on it)
                continue;
            }
            
            doc.fontSize(8).fillColor(footerColor).text(footerText, 50, 785, { align: 'center' });
        }

        doc.end();

    } catch (error) {
        console.error('SERVER ERROR (PDF):', error);
        if (!res.headersSent) res.status(500).json({ error: 'Error del servidor: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
