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

// Generate Booking Report PDF (Larger Text - No Footers)
app.post('/api/generate-booking-report', async (req, res) => {
    try {
        const data = req.body;
        const type = data.type || 'summary';
        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=documento.pdf`);
        doc.pipe(res);

        const MARGIN_X = 50;
        const format = (val) => {
            const n = parseFloat(val || 0);
            return '$ ' + n.toLocaleString('es-CO');
        };

        const addLogo = () => {
            const logoPath = path.join(__dirname, 'Logotipo color.png');
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, MARGIN_X, 25, { width: 110 });
            }
        };

        // --- Summary Logic (THE PERFECT ONE) ---
        if (type === 'summary') {
            addLogo();
            doc.moveDown(5);
            doc.font('Helvetica-Bold').fontSize(16).text('INFORME DE RESERVA', { align: 'center' });
            doc.moveDown(2);

            const drawLine = (label, value) => {
                doc.font('Helvetica').fontSize(11).fillColor('#000000').text(label, MARGIN_X, doc.y, { continued: true });
                doc.font('Helvetica-Bold').text(String(value || ''));
                doc.moveDown(0.5);
            };

            drawLine('Fecha de la Reserva: ', `${data.fechaReserva || ''} de 2026`);
            drawLine('Nombre de la Reserva: ', `${data.nombreReserva || ''}    C.C : ${data.ccReserva || ''}`);
            drawLine('Personas: ', data.personas);
            drawLine('CODIGO DE LA RESERVA: ', data.codigoReserva);
            drawLine('Dirección del inmueble: ', data.direccionInmueble);
            drawLine('Entrada: ', `${data.entrada || ''}`);
            drawLine('Salida: ', `${data.salida || ''}`);
            drawLine('Valor noche Adicional: ', format(data.valorNocheAdicional));
            drawLine('Valor total del Arriendo mensual: ', format(data.valorTotalArriendo));
            
            doc.moveDown(1);
            drawLine('BONO REMBOLSABLE: ', `${format(data.bonoReembolsable)} por pérdidas o daños.`);
            drawLine('Aseo: ', format(data.aseo));
            
            const total = parseFloat(data.valorTotalArriendo || 0) + parseFloat(data.aseo || 0) + parseFloat(data.bonoReembolsable || 0);
            const res30 = Math.round(total * 0.3);
            const saldo = total - res30;

            drawLine('Total: ', format(total));
            doc.moveDown(1);
            drawLine('Valor para reservación (30% del total) ', format(res30));
            drawLine('Saldo al entrar al apartamento: ', format(saldo));
            
            doc.font('Helvetica').fontSize(11).text('De los cuales ', { continued: true });
            doc.font('Helvetica-Bold').text(`${format(data.bonoReembolsable)}`, { continued: true });
            doc.font('Helvetica').text(' son reembolsables al revisar el inventario y este al dia.');

            doc.moveDown(1.5);
            doc.font('Helvetica').fontSize(11).text('La comisión de la consignación cobrada por el banco deberá ser paga por el huésped', { align: 'left' });
            doc.moveDown(0.5);
            doc.text('En el momento de la llegada se debe cancelar la totalidad del dinero.');
            doc.moveDown(0.5);
            doc.text(`Todas las propiedades tienen una tarifa de limpieza de COP ${format(data.aseo)}. Esta tarifa No está incluida en el valor del alquiler y se paga una sola vez por la propiedad (no es por persona ni por noche).`);

            doc.moveDown(1.5);
            // Missing content restored from turn 875
            doc.fontSize(10.5).text('Contamos con seguro médico en caso de accidente o enfermedad que ocurra dentro del inmueble. Pregúntame cómo obtenerlo');
            doc.moveDown(1);
            doc.text('El ingreso de un número de personas mayor a las autorizadas, genera incumplimiento del contrato. Por tanto, se podrá dar por cancelado el mismo sin devolución alguna del dinero recibido. En caso de autorizarse, el valor por persona extra es de $50.000 DIARIO', { align: 'justify' });
            doc.moveDown(1);
            doc.text('El valor del depósito se reintegra cuando el propietario revise el inventario En contratos celebrados a meses, el depósito será devuelto 60 días después de la salida', { align: 'justify' });
            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('Hora de entrada (check in): 3:00 PM');
            doc.font('Helvetica').text('Hora de salida (check out): 12:00 PM');

            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('CLÁUSULA X — POLÍTICAS DE CANCELACIÓN, REEMBOLSO Y CONDICIONES DE ENTREGA DEL INMUEBLE');
            doc.font('Helvetica').text('En el momento en que se realiza la reserva, el apartamento se retira de la plataforma lo que impide que pueda ser tomado por otras personas. Por esta razón, el inmueble pierde la posibilidad de volver a ofrecerse y, en consecuencia, el 30% pagado por concepto de reserva no es reembolsable.', { align: 'justify' });

            doc.moveDown(1.5);
            doc.font('Helvetica').fontSize(10.5).text('Acepta términos y condiciones https: rentahouse01@hotmail.com-rentahouse@gmail.com');
            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('Aceptación de las Condiciones');
            doc.font('Helvetica').text('El ARRENDATARIO declara haber leído, comprendido y aceptado esta cláusula como parte integral del contrato de arrendamiento temporal celebrado con ALQUILER RENTA HOUSE');
            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('Aceptación de las Condiciones');
            doc.font('Helvetica').text('El ARRENDATARIO declara haber leído, comprendido y aceptado esta cláusula como parte integral del contrato de arrendamiento temporal celebrado con ALQUILER RENTA HOUSE.');
            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('4. Aceptación por Silencio del Arrendatario');
            doc.font('Helvetica').text('Una vez ALQUILER RENTA HOUSE envíe al ARRENDATARIO el contrato, anexos, inventarios o cualquier información relacionada con el alojamiento, a través de WhatsApp, correo electrónico u otro medio autorizado, y no exista respuesta u objeción dentro de un plazo máximo de veinticuatro (24) horas, se entenderá que el ARRENDATARIO acepta en su totalidad el contenido enviado.', { align: 'justify' });

            doc.moveDown(1.5);
            doc.font('Helvetica-Bold').fontSize(11).text('METODO DE PAGO', { align: 'left' });
            doc.font('Helvetica').fontSize(10.5).text(data.metodoPago || 'TRANSFERENCIA BANCARIA');
            doc.end();

        } else if (type === 'contract') {
            // --- Full Contract Logic (TABLE LAYOUT) ---
            doc.on('pageAdded', () => {
                addLogo();
                doc.y = 80;
            });

            addLogo();
            doc.y = 80;

            doc.font('Helvetica-Bold').fontSize(14).text('CONTRATO TEMPORAL DE ARRENDAMIENTO DE INMUEBLE AMOBLADO', { align: 'center' });
            doc.moveDown(2);

            const MARGIN_X = 50;
            doc.font('Helvetica-Bold').fontSize(10);

            // Top Fields (Non-table)
            doc.text('ARRENDADOR:  ', MARGIN_X, doc.y, { continued: true });
            doc.font('Helvetica').text('ALQUILER RENTA HOUSE representado por YOJANNA YULIETH SERRANO GOMEZ identificada con cédula de ciudadanía # 1’095.827.048 de Bucaramanga, con matrícula mercantil 681907 ubicados en la CALLE. 32 # 32-64 LOCAL 11 CENTRO COMERCIAL RIVERA PLAZA barrio la Aurora, teléfonos 3165791058 – 3167583928- 6076901312', { align: 'justify' });
            doc.moveDown(1);

            doc.font('Helvetica-Bold').text('ARRENDATARIO: ', { continued: true });
            doc.font('Helvetica').text(`${data.nombreReserva || ''} `, { continued: true });
            doc.font('Helvetica-Bold').text('TIPO Y NUMERO DE ID: ', { continued: true });
            doc.font('Helvetica').text(`CC. ${data.ccReserva || ''}`);
            doc.moveDown(0.5);

            doc.font('Helvetica-Bold').text('CORREO: ', { continued: true });
            doc.font('Helvetica').text(`${data.emailReserva || ''}`, { continued: true });
            const emailWidth = doc.widthOfString(`CORREO: ${data.emailReserva || ''}`);
            doc.font('Helvetica-Bold').text('                                                                   TEL: ', { continued: true });
            doc.font('Helvetica').text(`${data.telReserva || ''}`);
            doc.moveDown(0.5);

            doc.font('Helvetica-Bold').text('EN CASO DE EMERGENCIA: ', { continued: true });
            doc.font('Helvetica').text(`${data.emergenciaNombre || ''}`, { continued: true });
            doc.font('Helvetica-Bold').text('                                            TEL: ', { continued: true });
            doc.font('Helvetica').text(`${data.emergenciaTel || ''}`);
            doc.moveDown(1);

            // Table Drawing helper
            const startY = doc.y;
            const tableWidth = 512;
            const col1Width = 180;
            const col2Width = tableWidth - col1Width;
            const rowHeight = 25;

            const drawRow = (label, value, customHeight = 25) => {
                const currentY = doc.y;
                const h = customHeight;
                doc.rect(MARGIN_X, currentY, tableWidth, h).stroke();
                doc.moveTo(MARGIN_X + col1Width, currentY).lineTo(MARGIN_X + col1Width, currentY + h).stroke();

                doc.font('Helvetica-Bold').fontSize(9).text(label, MARGIN_X + 5, currentY + 5, { width: col1Width - 10 });
                doc.font('Helvetica').fontSize(10).text(String(value || ''), MARGIN_X + col1Width + 5, currentY + 7, { width: col2Width - 10 });
                
                doc.y = currentY + h;
            };

            drawRow('DIRECCION DE INMUEBLE', data.direccionInmueble);
            drawRow('FECHA DE INGRESO', `${data.entrada || ''}`);
            drawRow('FECHA DE SALIDA', `${data.salida || ''}`);
            drawRow('CANON DE ARRENDAMIENTO MENSUAL. LIBRE DE RETENCION EN LA FUENTE.', format(data.valorTotalArriendo), 35);
            drawRow('IVA', '$ 0');
            drawRow('RETENCION EN LA FUENTE', '$ 0');
            drawRow('VALOR POR NOCHE ADICIONAL', format(data.valorNocheAdicional));
            drawRow('VALOR DE ASEO: SOLO UNA VEZ', format(data.aseo));
            drawRow('BONO DE GARANTIA', format(data.bonoReembolsable));
            
            const totalVal = parseFloat(data.valorTotalArriendo || 0) + parseFloat(data.aseo || 0) + parseFloat(data.bonoReembolsable || 0);
            drawRow('VALOR TOTAL CANCELADO', format(totalVal));
            drawRow('NUMERO DE PERSONAS', data.personas);

            doc.moveDown(2);
            doc.font('Helvetica-Bold').fontSize(11).text('CONDICIONES GENERALES', MARGIN_X, doc.y, { align: 'left' });
            doc.moveDown(1);

            const legalText = (title, body) => {
                if (title) {
                    doc.font('Helvetica-Bold').fontSize(10).text(title, MARGIN_X, doc.y, { align: 'left' });
                    doc.moveDown(0.3);
                }
                
                doc.x = MARGIN_X;
                const words = body.split(/(\s+)/);
                words.forEach(word => {
                    const clean = word.trim();
                    const isUpper = clean.length >= 2 && /^[^a-z]+$/.test(clean) && /[A-ZÁÉÍÓÚÑ]/.test(clean);
                    doc.font(isUpper ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
                    doc.text(word, { continued: true, width: 512, align: 'justify' });
                });
                doc.text('', { continued: false });
                doc.moveDown(1);
            };

            legalText('PRIMERA:', `El canon de arrendamiento deberá estar cancelado a su totalidad momento de la entrega del inmueble. Y mes a mes dos días antes del ${data.salida || 'vencimiento'} que es la fecha de vencimiento del contrato, si por incumplimiento no se llegará a realizar el pago oportunamente, EN LA FECHA ACORDADA, EL ARRENDATARIO, autoriza amplia y de manera total AL ARRENDADOR, a acceder al inmueble arrendado, tomar como prenda de respaldo sus pertenencias, cambiar las guardas y hacer uso de sus facultades como encargado para reestablecer el poder de la propiedad, renunciando a interponer acciones jurídicas o policivas para conservar su estadía morosa en el inmueble, así como renunciar a cualquier tipo de cobro por este motivo.`);

            legalText('PARÁGRAFO 2º.-', `El ARRENDATARIO, en respaldo del presente contrato deja en poder del ARRENDADOR un bono de garantía por valor de ${format(data.bonoReembolsable)} PESOS, un pagare en blanco, con carta instrucciones, por concepto de ingreso y ocupación adicional del número de personas autorizadas, posibles daños ocasionados y perdidas del mobiliario, al inmueble y a las zonas comunes, el costo de los daños y pérdidas, la restauración o reposición total, consumo adicional por concepto de servicios públicos básicos domiciliarios; que excedan del valor del bono de garantía, la no entrega formal del inmueble. No existiendo reclamación alguna respecto del presente contrato.`);
            
            legalText('PARÁGRAFO 3º.-', `Para contratos que su vigencia sea de un término de treinta (30) días o más, el bono de garantía, el pagaré y la carta de instrucciones serán entregados en un término de SESENTA (60) días siguientes a la fecha de entrega del inmueble previa verificación por parte del propietario del inmueble de que el ARRENDATARIO no ha pasado del consumo máximo de servicios públicos básicos domiciliarios establecido en el presente contrato. EN CONTRATOS POR DIAS EL BONO DE GARANTÍA SERA DEVUELTO EN CUANTO EL PROPIETARIO REVISE EL INMUEBLE, SE DEVOLVERA EL BONO DE GARANTÍA EN 3 DIAS EXCEPTO LOS DIAS DOMINICALES Y FESTIVOS.`);
            
            legalText('PARAGRAFO PRIMERO.-', `En caso de ser cliente extranjero quien figure como titular del presente contrato, además de todo lo pactado, nos autoriza a reportar a las centrales, entidades policivas, organismos internacionales y nacionales, su comportamiento en la unidad, el apartamento y con terceros, además, nos autoriza para que: en caso de no cumplir con sus obligaciones se le impida su salida del país hasta lograr el Cumplimiento satisfactorio de las mismas y adicional se le cobrará una multa de gestión de cobranza por valor de $3.600.000 y desde luego el cobro de todos los costos que se generen.`);
            
            legalText('PARÁGRAFO 4º. -', `Nos reservamos el derecho de inspección del inmueble, un día antes de la entrega; inspección que podrá ser realizada por un funcionario de nuestra empresa o por el propietario del inmueble, previo acuerdo con el ARRENDATARIO de la hora, lo anterior para verificar posibles daños ocasionados y perdidas del mobiliario, al inmueble y a las zonas comunes, y estimar el costo de los daños y pérdidas, la restauración o reposición total.`);

            legalText('PARÁGRAFO 5º. -', `Si el ARRENDADOR se encuentra en la imposibilidad de cumplir con la reserva del inmueble por causas ajenas a su voluntad, podrá ofrecer al ARRENDATARIO otro inmueble de similar precio y característica para el cumplimiento del presente contrato.`);

            legalText('PARAGRAFO 6º, -', `En el evento de que el propietario del inmueble proceda a la venta del mismo durante el tiempo de ejecución del contrato o se encuentre en reserva, el presente contrato se declara resuelto y sin valor alguno de común, acuerdo entre las partes; eximiéndose de responsabilidad alguna al ARRENDADOR; y no podrá alegarse sanción de incumplimiento por parte del ARRENDATARIO. Así mismo, al ARRENDATARIO se le devolverá el cien por ciento (100%) de lo cancelado a la fecha.`);

            legalText('SEGUNDO: RECIBO Y ESTADO. -', `El ARRENDATARIO verificará el buen estado del inmueble objeto de este contrato, según el inventario, sea físico o digital; que se realizará con la persona encargada de realizar la entrega del inmueble. Este documento hace parte integral del presente contrato. Además del inmueble identificado y descrito anteriormente tendrá el ARRENDATARIO derecho de uso y goce sobre las cosas.`);
            
            legalText('', `El ARRENDATARIO se compromete a utilizar los muebles, equipos y zona social del inmueble de manera adecuada conservándolas en el estado en que se encuentran y, por tanto, responderá por cualquier daño o pérdida de los elementos y bienes del inmueble, hasta por la culpa leve Si en el transcurso de la ocupación el ARRENDATARIO o sus dependientes ocasionan pérdida, daño total o parcial de los bienes del inmueble, al mobiliario, al inmueble y a las zonas comunes, deberá informarlos inmediatamente y se compromete a cancelar el precio establecido en el mercado, los costos de su restauración o su reposición total, según cotizaciones y estado de los objetos. El valor adicional por este concepto será cancelado por el ARRENDATARIO veinticuatro (24) horas siguientes a la entrega del inmueble en las oficinas del ARRENDADOR, so pena de no realizar la entrega del bono de garantía y el pagaré firmado en respaldo del presente contrato, el cual se hará efectivo por parte del ARRENDADOR`);

            legalText('PARÁGRAFO 1º.-', `Se prohíbe al ARRENDATARIO realizar fiestas, escándalos, el consumo de sustancias alucinógenas, prohibido fumar cigarrillo, portar armas, colgar ropa en fachadas, balcones o ventanas y cualquier tipo de actividad ilegal dentro del apartamento y conjunto residencial que atente contra las buenas costumbres y las normas de convivencia, ante cualquier queja de la comunidad, entraremos a tomar posesión y desalojaremos inmediatamente al huésped, y se cobrará la multa que por cada falta la administración notifique, Por faltar a cualquiera de las prohibiciones cobraremos como multa adicional $500.000, y EL ARRENDATARIO, acepta esta condición sin requerimiento, y el propietario podrá exigir el monto adicional, necesario para lograr la limpieza optima, indicada en ${format(data.valorAseo)} y la reparación inmediata de daños causados por mascotas, visitantes, u otros habitantes del inmueble, si los hubiera. En desarrollo a lo dispuesto en el artículo 17 de la ley 679 del 2001 y 1336 de 2009, se advierte al huésped que la explotación y el abuso sexual de menores de edad en el país son sancionados penal y administrativamente conforme a la ley, de igual manera queda prohibido.`);

            legalText('PARAGRAFO PRIMERO: -', `Todo menor de edad debe estar acompañado de un adulte responsable, portar su documento que acredite parentesco y en caso de no estar con al menos uno de sus padres debe contar con autorización autenticada de los padres para su estadía Rechazamos el turismo sexual con menores y es necesario al momento de ingreso el registro civil o documento de identidad que acredite parentesco.`);

            legalText('PARÁGRAFO 2º. -', `Se prohíbe el ingreso de algún tipo de mascota, El ingresar cualquier tipo de mascota acarrea una penalidad de 1 canon.`);

            legalText('PARÁGRAFO 3º. -', `El ARRENDATARIO manifiesta que ha recibido la información verbal y escrita suficiente sobre la capacidad máxima de ocupación de acuerdo a lo especificado en el presente contrato, estado del mobiliario del inmueble, estado de las zonas comunes, los servicios públicos básicos domiciliarios con los que cuenta y la ubicación del inmueble que alquila. Se deja constancia que se realiza entrega al ARRENDATARIO del plano de ubicación y forma de llegar al inmueble, por tanto, es su responsabilidad portar el plano de llegada, suministrado por el ARRENDADOR para su correcta ubicación y llegada al inmueble, La permanencia nocturna en el inmueble de más huéspedes de lo previamente acordado en el contrato es motivo de desalojo sin devolución ninguna de dinero. Los invitados al inmueble están obligados a declarar sus nombres, número de pasaporte o documento, en la portería, exhibiendo la documentación correspondiente si se lo solicitarán.`);

            legalText('PARAGRAFO 4º. -', `El ARRENDATARIO acepta y declara que ha recibido el inmueble con todas sus instalaciones eléctricas, sanitarias, hidráulicas, tv, internet y de gas en perfecto estado de funcionamiento y se compromete a entregarlas en el mismo estado. Que se ha hecho saber que tiene derecho sobre los servicios públicos básicos domiciliarios por la suma de $80.000 AGUA, $80.000 LUZ Y $20,000 GAS hasta por un consumido máximo, lo que exceda por los servicios este valor deberá ser asumido en totalidad por el ARRENDATARIO, en casos de ser superior a un mes, debe cancelar mes a mes el excedente causado; cuando es solo un mes, podrá ser descontada a buena cuenta por el bono de garantía y lo faltante deberá ser cancelado en dinero en efectivo para que el pagaré sea devuelto. EL ARRENDADOR NO autoriza AL ARRENDATARIO para adquirir créditos, comprar electrodomésticos y demás compromisos comerciales o civiles, mediante las facturas de los servicios públicos, Ni para que adquieran servicios públicos que involucren el bien arrendado. En caso de incumplimiento o retrasos en el pago EL ARRENDATARIO autoriza AL ARRENDADOR a disponer cortar o suspender los servicios públicos, sin exigir ninguna contraprestación por perjuicios y sin oponer resistencia, ni imponer queja alguna, pues reconoce que hace parte del acuerdo y conoce las consecuencias de su incumplimiento.`);

            legalText('PARAGRAFO. -', `Si como consecuencia del no pago oportuno del canon, se llegará a no realizar el pago de los servicios públicos, las empresas respectivas suspenden o retiran el contador, serán de cargo DEL ARRENDATARIO el pago de los intereses de mora, y los gastos que demanden su reconexión.`);

            legalText('TERCERA -', `El ARRENDADOR no se hace responsable por la pérdida de objetos personales y dinero de propiedad del ARRENDATARIO, en el periodo de ocupación determinado en este contrato. El cuidado de los objetos llevados al inmueble será de absoluta y total responsabilidad del ARRENDATARIO. Así mismo, el ARRENDATARIO exime al ARRENDADOR y propietario del inmueble, de toda responsabilidad civil, extracontractual o penal, originadas por causa de accidentes dentro y fuera del apartamento, averías, fallas técnicas, cortocircuitos, derrumbes, desperfectos, filtraciones, incendios, inundaciones, pandemias, terremotos, rupturas, terrorismo, delincuencia, fallas en el conjunto cerrado sobre la seguridad o mantenimiento en áreas privadas o comunes, y/o cualquiera causa, o consecuencias de ellas, incluyendo las enunciadas en los Art. Pertinentes en el Código Civil, ya que EL ARRENDATARIO las toma a su cargo como riesgo propio, incluso el caso fortuito y la fuerza mayor. Queda prohibido al ARRENDATARIO y acompañantes depositar materiales o residuos inflamables, tóxicos y/o peligrosos en el apartamento amoblado en arriendo, así como armas, y sustancias prohibidas. El presente contrato y los derechos y obligaciones que de él se derivan, no podrán ser cedidos, total o parcialmente por ninguna de las partes a terceros, sin la previa autorización escrita de la otra parte.`);

            legalText('CUARTA: HORARIO DE ENTRADA Y SALIDA DEL INMUEBLE. -', `Es entendido el ARRENDATARIO que el día de alquiler, está comprendido en el horario de 03:00 p.m. día de entrada, a la 11:00 a.m., del día de salida. No obstante, se podrá, con previo acuerdo entre las partes, estipular un horario de entrada y salida del inmueble, diferente al aquí pactado, si es autorizado por el propietario del inmueble y si no hubiese reservación del mismo inmueble. Horario del cual se dejará constancia en las observaciones del presente contrato.`);

            legalText('QUINTA: SANCIÓN POR INCUMPLIMIENTO.', `EL ARRENDATARIO, acepta que las fechas solicitadas y acordadas no se pueden disminuir, ni trasladar, y NO se devolverá dinero PAGADO por la reserva realizada, bajo ningún argumento, y que, en caso de presentarse, se tomará dicho valor como indemnización AL ARRENDADOR, por que dejó de alquilarlo a otras personas, porque se generaron costos de alistamiento, y gastos administrativos, y porque el que incumple con los tiempos solicitados es EL ARRENDATARIO.`);

            legalText('PARÁGRAFO 1.-', `La modificación de la fecha de la reserva sin que implique sanción para el ARRENDATARIO solo se permitirá por una única vez, si se informa al ARRENDADOR con 8 días de antelación a la fecha de iniciación de este contrato. La nueva fecha de reserva deberá fijarse para un término no mayor a sesenta (60) días a la fecha inicialmente pactada. Si modificada la fecha de reserva el ARRENDATARIO no utiliza la misma, perderá el cien por ciento (100%) del valor del contrato, a título de sanción.`);

            legalText('PARÁGRAFO 2.-', `El incumplimiento por parte del ARRENDATARIO de cualquiera de las cláusulas de este contrato, lo constituirá en deudor del ARRENDADOR por una suma equivalente al valor de lo cancelado por concepto del alquiler pactado en el presente contrato a título de sanción. Se entenderá, en todo caso, que el pago de la sanción no extingue la obligación principal y que el ARRENDADOR podrá pedir a la vez el pago y la indemnización de perjuicios, si es el caso Este contrato será prueba sumaria suficiente para el cobro de esta sanción y el ARRENDATARIO renuncia expresamente a cualquier requerimiento privado o judicial para constituirlo en mora del pago de esta o cualquier otra obligación derivada del contrato. La tolerancia por parte DE EL ARRENDADOR a recibir extemporáneamente y/o fraccionadamente uno o más pagos, no implica condonación de la mora y no constituye modificación del término de pago establecido en este contrato. Pero si genera el cobro de una sanción por incumplimiento así, de 1 a 10 días $100.000, de 11 a 30 días una sanción por $200.000 pagaderos junto con el valor del correspondiente mes en mora, pero en todo caso no se permitirán retrasos en el pago y se aplicará lo contenido en la CLÁUSULA PRIMERA del presente contrato.`);

            legalText('SEXTA. - OBLIGACIONES DEL ARRENDATARIO. -', `Además de las establecidas en el texto del contrato y en la ley, son obligaciones DEL ARRENDATARIO, las siguientes: 6.1 Destinar el bien arrendado para los fines mencionados en el presente contrato, además aceptando y respetando el Reglamento de propiedad horizontal que rige la unidad. So pena de pago de multas o demás que se generen. 6.2 Cancelar oportunamente el canon, diario, mensual o el tiempo requerido, al ARRENDADOR. Si por culpa u omisión de pago de EL ARRENDATARIO los servicios, tales como, administración, cable, internet, agua, luz y gas, son suspendidos, serán por su cuenta los gastos de reconexión y las respectivas multas. 6.3 Restituir el inmueble con sus accesorios descritos en el Inventario en la fecha de terminación del contrato, en el estado en el cual fueron entregados, salvo el deterioro normal por un uso adecuado y normal, en caso de algún daño en los artículos o muebles, éstos deben ser reemplazados por uno igual en calidad, diseño, estilo y precio.`);

            legalText('SEPTIMA. - OBLIGACIONES DEL ARRENDADOR. -', `Además de las establecidas en el texto del contrato y en la ley, son obligaciones de EL ARRENDADOR, las siguientes: 7.1 Entregar al ARRENDATARIO el inmueble arrendado en la fecha establecida en la cláusula primera, así como sus servicios, muebles y enseres ofertados, presentar y entregar inventario físico o fotográfico explicado y aceptado por las partes e igualmente verificado. 7.2 Mantener el inmueble, los servicios públicos al día y muebles en condiciones tales que permitan su uso y goce normal.`);

            legalText('PARÁGRAFO. -', `En cuanto a calidad de los servicios públicos, EL ARRENDADOR, no se hace responsable por el mal funcionamiento del servicio que ofrece la empresa proveedora de telecomunicaciones o garantías, reparación y mantenimiento a electrodomésticos, gasodomésticos y otros, ya que no es un servicio directo, puesto que como es de conocimiento general dichos servicios se contratan con empresas privadas y se está sujeto a sus tiempos de revisiones, servicio técnico o tiempos de respuesta a solicitudes, pero si se compromete a realizar las gestiones necesarias para que se resta(están los servicios y se generen los arreglos que se requieran. Los costos por daños generados por el uso inadecuado serán asumidos en su totalidad por el ARRENDATARIO, así como las visitas técnicas en las que se determine la inexistencia de una real atención tendrán un costo por $30.000 cada una. 7.3 Presentar por escrito a los habitantes informados dentro del formulario de reserva, ante la administración para su respetivo registro en portería y administración. 7.4 Entregar llaves de ingreso, de seguridad (si tuviera) y habitaciones (opcional), dejando claridad que son de uso exclusivo y solo se cuenta con las llaves entregadas, por seguridad, EL ARRENDADOR no se queda con ninguna copia, y en caso de extraviarlas o partirlas, el ARRENDATARIO asume su reemplazo y los servicios de cerrajería.`);

            legalText('OCTAVA-MERITO EJECUTIVO:', `El presente contrato presta mérito ejecutivo para exigir el pago de la sanción penal por incumplimiento, las sumas de dinero establecidas en el precio del arrendamiento, así como cualquier otra suma a cargo del ARRENDATARIO, para lo cual bastará, la sola afirmación hecha en la demanda por el ARRENDADOR, que no podrá ser desvirtuada por el ARRENDATARIO, sino con la presentación de los respectivos recibos de pago.`);

            legalText('NOVENA. - TERMINACIÓN DEL CONTRATO:', `Para terminación del presente contrato deberá darse aviso con 8 días hábiles de anticipación a la fecha de terminación, en caso de no darse aviso por las dos partes, se hará prorrogable el contrato. 2. Por incumplimiento de cualquiera de las obligaciones de las partes. El incumplimiento del ARRENDATARIO no lo exonera del pago del canon completo por el plazo pactado, 3, Cuando el contrato sea celebrado día a día, es decir cuando no consta el término exacto de permanencia del ARRENDATARIO en el inmueble, el contrato se dará por terminado al vencimiento del día fijado en el presente contrato. 4. La destinación del inmueble para fines ilícitos o contrarios a las buenas costumbres, o que representen peligro para el inmueble o la salubridad de sus habitantes. 5. Por la cesión del contrato o del goce del inmueble y/o subarriendo total o parcial del inmueble arrendado sin autorización expresa y escrita del ARRENDADOR. 6. Por el cambio o reforma de cualquier parte del inmueble realizada por el ARRENDATARIO, sin autorización. 7. Por la incursión reiterada del ARRENDATARIO en procesos que afecten la tranquilidad de los vecinos, por ruidos fuertes, por ingreso a visitantes múltiples, escándalos, mal ambiente para con el vecindario, conductas inapropiadas, fumar dentro del apartamento o áreas comunes.`);

            legalText('PARAGRAFO. -', `En caso de incumplimiento del pago del canon u otros valores, u otras causales de restitución, el HUESPED acepta y es de su conocimiento que el día acordado como la fecha límite de pago si no es recibido el canon acordado, SE APLICARA ALLANAMIENTO Y EL DESALOJO INMEDIATO, se enviará una autorización de no ingreso al apartamento, ni al conjunto, al cuerpo de vigilancia y administración, y acepta que esta autorización no generará ningún tipo de violación o abuso en su contra, y que acepta este es un mecanismo para garantizar el cumplimiento, y tampoco genera ningún cobro por indemnizaciones o perjuicio alguno a su favor, reconoce que esto no representa ningún secuestro ni retención, y acepta las consecuencias derivadas del caso. En caso de mora, el ARRENDATARIO autoriza al ARRENDADOR para que realice en su calidad de acreedor, el reporte negativo a las diferentes centrales riesgo y/o entidades relacionadas, medios de comunicación, redes sociales, policivas, civiles, o comerciales, e inicie procesos jurídicos. Y así mismo autoriza al ARRENDADOR para llenar los espacios del pagaré en blanco adjunto al presente contrato y la retención del bono de respaldo. Así como también autoriza al ARRENDADOR a ingresar a tomar posesión inmediata del inmueble sin requerimiento judicial, ni notificación alguna, solo con la presentación del presente contrato ante la entidad policial, como prueba del compromiso y la obligación contraída como ARRENDATARIO, comprometiéndose a desalojar- voluntaria e inmediatamente el inmueble, manteniendo las obligaciones pactadas vigentes hasta encontrarse a paz y salvo por todo concepto a favor del ARRENDADOR`);

            legalText('DÉCIMA. -', `Para efectos de notificaciones el ARRENDADOR recibirá notificaciones en la CALLE 32 32-64 CENTRO COMERCIAL. RIVERA PLAZA LOCAL 11`);

            legalText('UNDÉCIMA. - ESPACIOS EN BLANCO:', `El ARRENDATARIO faculta expresamente al ARRENDADOR para llenar en este documento los espacios en blanco`);

            legalText('UNDÉCIMA PRIMERA. - AUTORIZACIONES:', `El ARRENDATARIO autoriza de manera irrevocable al ARRENDADOR o a quien represente sus derechos u ostente en el futuro la calidad de acreedor, para que en el evento en que se constituya en mora en el pago de sumas de dinero generadas por la ejecución de este contrato o cualquier otro concepto que sea a su cargo, durante el término de duración del contrato, se incorporen sus nombre, apellidos, razón social y documentos de identificación de los archivos de deudores morosos o con referencias negativas que lleven CIAN, DATACREDITO, FIANZACREDITO INMOBILIARIO DE SANTANDER S.A., LONJA DE PROPIEDAD RAIZ DE SANTANDER, o cualquier otra entidad encargada del manejo de datos comerciales, personales o económicos, El ARRENDATARIO exonera de toda responsabilidad por la inclusión de tales datos al ARRENDADOR como a la entidad que produzca el correspondiente archivo. El ARRENDATARIO manifiesta que todos los datos aquí consignados son ciertos, que la información suministrada al ARRENDADOR es veraz y verificable, y autoriza su verificación ante cualquier persona natural, jurídica o entidad pública, sin limitación alguna, mientras subsistan las obligaciones adquiridas en el presente contrato.`);

            legalText('UNDÉCIMA SEGUNDA: CONSTANCIA DE RECIBIDO DE ESTE CONTRATO:', `se deja constancia al firmar este contrato que todas las partes reciben copia de este.`);

            legalText('UNDÉCIMA TERCERA:', `Nos reservamos el derecho de admisión. Solo es permitido ingresar a la propiedad grupos familiares o empresariales. Este servicio no se presta para grupos estudiantiles y menores de edad. La empresa no se hace responsable del impedimento de ingreso a la propiedad en caso de ser falsa la información suministrada.`);

            legalText('UNDÉCIMA CUARTA:', `El ARRENDATARIO autoriza de manera irrevocable al ARRENDADOR o a quien represente sus derechos para que los datos de identificación suministrados en el presente contrato sean entregados a las autoridades municipales, departamentales, de policía y judiciales que para efectos de control, supervisión y seguridad realicen al establecimiento de comercio.`);

            doc.moveDown(2);
            doc.font('Helvetica-Bold').fontSize(10).text('ARRENDADOR:', MARGIN_X, doc.y, { align: 'left' });
            doc.moveDown(2);
            doc.text('_________________________________', MARGIN_X, doc.y);
            doc.text('YOJANNA YULIETH SERRANO GOMEZ', MARGIN_X, doc.y);
            doc.text('CC 1.095.827.048', MARGIN_X, doc.y);

            doc.moveDown(3);
            doc.text('ARRENDATARIO:', MARGIN_X, doc.y, { align: 'left' });
            doc.moveDown(2);
            doc.text('_________________________________', MARGIN_X, doc.y);
            doc.text(String(data.nombreReserva).toUpperCase(), MARGIN_X, doc.y);
            doc.text(`CC. ${data.ccReserva}`, MARGIN_X, doc.y);

            doc.end();
        }

    } catch (error) {
        console.error('SERVER ERROR (PDF):', error);
        if (!res.headersSent) res.status(500).json({ error: 'Error del servidor: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
