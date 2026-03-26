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

        // Summary Logic (Existing but refined)
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
            drawLine('Entrada: ', `${data.entrada || ''} DE 2026`);
            drawLine('Salida: ', `${data.salida || ''} DE 2026`);
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
            doc.font('Helvetica').fontSize(11).text('La comisión de la consignación cobrada por el banco deberá ser paga por el huésped');
            doc.moveDown(1);
            doc.text('En el momento de la llegada se debe cancelar la totalidad del dinero.');
            doc.moveDown(1);
            doc.text(`Todas las propiedades tienen una tarifa de limpieza de COP ${format(data.aseo)}. Esta tarifa No está incluida en el valor del alquiler y se paga una sola vez por la propiedad (no es por persona ni por noche).`);

            doc.moveDown(2);
            doc.fontSize(10.5).text('Acepta términos y condiciones https: rentahouse01@hotmail.com-rentahouse@gmail.com');
            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('Aceptación de las Condiciones');
            doc.font('Helvetica').text('El ARRENDATARIO declara haber leído, comprendido y aceptado esta cláusula como parte integral del contrato de arrendamiento temporal celebrado con ALQUILER RENTA HOUSE');
            doc.moveDown(1);
            doc.font('Helvetica-Bold').text('4. Aceptación por Silencio del Arrendatario');
            doc.font('Helvetica').text('Una vez ALQUILER RENTA HOUSE envíe al ARRENDATARIO el contrato, anexos, inventarios o cualquier información relacionada con el alojamiento, a través de WhatsApp, correo electrónico u otro medio autorizado, y no exista respuesta u objeción dentro de un plazo máximo de veinticuatro (24) horas, se entenderá que el ARRENDATARIO acepta en su totalidad el contenido enviado.', { align: 'justify' });

            doc.moveDown(2);
            doc.font('Helvetica-Bold').fontSize(11).text('METODO DE PAGO');
            doc.font('Helvetica').fontSize(10.5).text(data.metodoPago || 'TRANSFERENCIA BANCARIA');
            doc.end();

        } else if (type === 'contract') {
            // Full Contract Logic
            doc.on('pageAdded', () => {
                addLogo();
                doc.y = 80;
            });

            addLogo();
            doc.y = 80;

            doc.font('Helvetica-Bold').fontSize(14).text('CONTRATO TEMPORAL DE ARRENDAMIENTO DE INMUEBLE AMOBLADO', { align: 'center' });
            doc.moveDown(1.5);

            const labelWidth = 180;
            const field = (label, value) => {
                const currentY = doc.y;
                doc.font('Helvetica-Bold').fontSize(10).text(label, MARGIN_X, currentY, { width: labelWidth });
                doc.font('Helvetica').text(String(value || 'N/A'), MARGIN_X + labelWidth, currentY);
                doc.moveDown(0.5);
            };

            field('ARRENDADOR:', 'ALQUILER RENTA HOUSE (YOJANNA YULIETH SERRANO GOMEZ - CC 1.095.827.048)');
            field('ARRENDATARIO:', data.nombreReserva);
            field('TIPO Y NUMERO DE ID:', data.ccReserva);
            field('CORREO:', data.emailReserva);
            field('TEL:', data.telReserva);
            field('EN CASO DE EMERGENCIA:', data.emergenciaNombre);
            field('TEL EMERGENCIA:', data.emergenciaTel);
            field('DIRECCION DE INMUEBLE:', data.direccionInmueble);
            field('FECHA DE INGRESO:', `${data.entrada || ''} DE 2026`);
            field('FECHA DE SALIDA:', `${data.salida || ''} DE 2026`);
            field('CANON MENSUAL:', format(data.valorTotalArriendo));
            field('VALOR POR NOCHE ADICIONAL:', format(data.valorNocheAdicional));
            field('VALOR DE ASEO:', format(data.aseo));
            field('BONO DE GARANTIA:', format(data.bonoReembolsable));
            
            const total = parseFloat(data.valorTotalArriendo || 0) + parseFloat(data.aseo || 0) + parseFloat(data.bonoReembolsable || 0);
            field('VALOR TOTAL CANCELADO:', format(total));
            field('NUMERO DE PERSONAS:', data.personas);

            doc.moveDown(1);
            doc.font('Helvetica-Bold').fontSize(11).text('CONDICIONES GENERALES');
            doc.moveDown(1);

            const legalText = (title, body) => {
                if (title) {
                    doc.font('Helvetica-Bold').fontSize(10).text(title);
                    doc.moveDown(0.3);
                }
                doc.font('Helvetica').fontSize(10).text(body, { align: 'justify' });
                doc.moveDown(1);
            };

            legalText('PRIMERA:', `El canon de arrendamiento deberá estar cancelado a su totalidad momento de la entrega del inmueble. Y mes a mes dos días antes del ${data.entrada || 'vencimiento'} que es la fecha de vencimiento del contrato, si por incumplimiento no se llegará a realizar el pago oportunamente, EN LA FECHA ACORDADA, EL ARRENDATARIO, autoriza amplia y de manera total AL ARRENDADOR, a acceder al inmueble arrendado, tomar como prenda de respaldo sus pertenencias, cambiar las guardas y hacer uso de sus facultades como encargado para reestablecer el poder de la propiedad, renunciando a interponer acciones jurídicas o policivas para conservar su estadía morosa en el inmueble, así como renunciar a cualquier tipo de cobro por este motivo.`);

            legalText('PARÁGRAFO 2º.-', `El ARRENDATARIO, en respaldo del presente contrato deja en poder del ARRENDADOR un bono de garantía por valor de ${format(data.bonoReembolsable)}, un pagare en blanco, con carta instrucciones, por concepto de ingreso y ocupación adicional del número de personas autorizadas, posibles daños ocasionados y perdidas del mobiliario, al inmueble y a las zonas comunes, el costo de los daños y pérdidas, la restauración o reposición total, consumo adicional por concepto de servicios públicos básicos domiciliarios; que excedan del valor del bono de garantía, la no entrega formal del inmueble. No existiendo reclamación alguna respecto del presente contrato.`);

            legalText('PARÁGRAFO 3º.-', `Para contratos que su vigencia sea de un término de treinta (30) días o más, el bono de garantía, el pagaré y la carta de instrucciones serán entregados en un término de SESENTA (60) días siguientes a la fecha de entrega del inmueble previa verificación por parte del propietario del inmueble de que el ARRENDATARIO no ha pasado del consumo máximo de servicios públicos básicos domiciliarios establecido en el presente contrato. EN CONTRATOS POR DIAS EL BONO DE GARANTÍA SERA DEVUELTO EN CUANTO EL PROPIETARIO REVISE EL INMUEBLE, SE DEVOLVERA EL BONO DE GARANTÍA EN 3 DIAS EXCEPTO LOS DIAS DOMINICALES Y FESTIVOS.`);

            legalText('PARAGRAFO PRIMERO.-', `En caso de ser cliente extranjero quien figure como titular del presente contrato, además de todo lo pactado, nos autoriza a reportar a las centrales, entidades policivas, organismos internacionales y nacionales, su comportamiento en la unidad, el apartamento y con terceros, además, nos autoriza para que: en caso de no cumplir con sus obligaciones se le impida su salida del país hasta lograr el Cumplimiento satisfactorio de las mismas y adicional se le cobrará una multa de gestión de cobranza por valor de $3.600.000 y desde luego el cobro de todos los costos que se generen.`);

            legalText('SEGUNDO: RECIBO Y ESTADO.-', `El ARRENDATARIO verificará el buen estado del inmueble objeto de este contrato, según el inventario, sea físico o digital; que se realizará con la persona encargada de realizar la entrega del inmueble. Este documento hace parte integral del presente contrato. Además del inmueble identificado y descrito anteriormente tendrá el ARRENDATARIO derecho de uso y goce sobre las cosas.`);
            
            legalText('', `El ARRENDATARIO se compromete a utilizar los muebles, equipos y zona social del inmueble de manera adecuada conservándolas en el estado en que se encuentran y, por tanto, responderá por cualquier daño o pérdida de los elementos y bienes del inmueble, hasta por la culpa leve. Si en el transcurso de la ocupación el ARRENDATARIO o sus dependientes ocasionan pérdida, daño total o parcial de los bienes del inmueble, deberá informarlos inmediatamente.`);

            legalText('PARÁGRAFO 1º.-', `Se prohíbe al ARRENDATARIO realizar fiestas, escándalos, el consumo de sustancias alucinógenas, prohibido fumar cigarrillo, portar armas, colgar ropa en fachadas, balcones o ventanas y cualquier tipo de actividad ilegal dentro del apartamento y conjunto residencial que atente contra las buenas costumbres y las normas de convivencia. Por faltar a cualquiera de las prohibiciones cobraremos como multa adicional $500.000.`);

            legalText('PARAGRAFO PRIMERO.-', `Todo menor de edad debe estar acompañado de un adulto responsable, portar su documento que acredite parentesco y en caso de no estar con al menos uno de sus padres debe contar con autorización autenticada de los padres para su estadía. El ingresar cualquier tipo de mascota acarrea una penalidad de 1 canon.`);

            legalText('PARÁGRAFO 4º.-', `El ARRENDATARIO acepta y declara que ha recibido el inmueble con todas sus instalaciones eléctricas, sanitarias, hidráulicas, tv, internet y de gas en perfecto estado de funcionamiento y se compromete a entregarlas en el mismo estado. Tiene derecho sobre los servicios públicos básicos domiciliarios por la suma de $80.000 AGUA, $80.000 LUZ Y $20.000 GAS hasta por un consumido máximo.`);

            legalText('TERCERA.-', `El ARRENDADOR no se hace responsable por la pérdida de objetos personales y dinero de propiedad del ARRENDATARIO, en el periodo de ocupación determinado en este contrato. El cuidado de los objetos llevados al inmueble será de absoluta y total responsabilidad del ARRENDATARIO. Así mismo, el ARRENDATARIO exime al ARRENDADOR de toda responsabilidad civil o penal originada por accidentes, averías, fallas técnicas, incendios o delincuencia.`);

            legalText('CUARTA: HORARIO DE ENTRADA Y SALIDA DEL INMUEBLE.-', `Es entendido el ARRENDATARIO que el día de alquiler, está comprendido en el horario de 03:00 p.m. día de entrada, a la 11:00 a.m., del día de salida. No obstante, se podrá, con previo acuerdo entre las partes, estipular un horario diferente.`);

            legalText('QUINTA: SANCIÓN POR INCUMPLIMIENTO.-', `EL ARRENDATARIO acepta que las fechas solicitadas y acordadas no se pueden disminuir, ni trasladar, y NO se devolverá dinero PAGADO por la reserva realizada, bajo ningún argumento, y que, en caso de presentarse, se tomará dicho valor como indemnización AL ARRENDADOR.`);

            legalText('PARÁGRAFO 2.-', `El incumplimiento por parte del ARRENDATARIO de cualquiera de las cláusulas de este contrato, lo constituirá en deudor del ARRENDADOR por una suma equivalente al valor de lo cancelado por concepto del alquiler pactado...`);

            doc.moveDown(2);
            doc.font('Helvetica-Bold').text('ARRENDADOR:');
            doc.moveDown(2);
            doc.text('_________________________________');
            doc.text('YOJANNA YULIETH SERRANO GOMEZ');
            doc.text('CC 1.095.827.048');

            doc.moveDown(3);
            doc.text('ARRENDATARIO:');
            doc.moveDown(2);
            doc.text('_________________________________');
            doc.text(String(data.nombreReserva).toUpperCase());
            doc.text(`CC. ${data.ccReserva}`);

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
