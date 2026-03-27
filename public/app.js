// Navigation Logic
const navLinks = document.querySelectorAll('.nav-links li');
const views = document.querySelectorAll('.view');
const viewTitle = document.getElementById('view-title');
const viewSubtitle = document.getElementById('view-subtitle');

const titles = {
    'chat-view': { title: 'Registro de Asientos con IA', sub: 'Escríbele al agente como si fuera tu contador de confianza.' },
    'ledger-view': { title: 'Libro Diario', sub: 'Historial de transacciones y movimientos exportables a Excel.' },
    'puc-view': { title: 'Plan Único de Cuentas (PUC)', sub: 'Listado oficial de cuentas contables de Colombia.' },
    'results-view': { title: 'Estado de Resultados', sub: 'Análisis de Ingresos, Gastos, Costos y Utilidad del Ejercicio.' },
    'docs-view': { title: 'Generador de Documentos', sub: 'Crea informes de reserva y contratos en PDF automáticamente.' },
    'help-view': { title: 'Asesoría Contable', sub: 'Haz consultas tributarias y contables libres al agente experto.' }
};

navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        
        const targetId = link.getAttribute('data-view');
        
        views.forEach(v => {
            v.classList.remove('active-view');
            if(v.id === targetId) v.classList.add('active-view');
        });

        viewTitle.textContent = titles[targetId].title;
        viewSubtitle.textContent = titles[targetId].sub;

        if (targetId === 'ledger-view') fetchLedger();
        if (targetId === 'puc-view') fetchPUC();
        if (targetId === 'results-view') fetchIncomeStatement();
    });
});

// Toast Logic
function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast show ${isError ? 'error' : ''}`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// Format Currency Cop
const formatCurrency = (amount) => {
    if(!amount) return '$0';
    return '$' + amount.toLocaleString('es-CO');
};

// --- Chat Logic ---
const chatMessages = document.getElementById('chat-messages');
const aiInput = document.getElementById('ai-input');
const sendBtn = document.getElementById('send-btn');

function addMessage(text, isUser = false) {
    const div = document.createElement('div');
    div.className = `message ${isUser ? 'user-msg' : 'system-msg'}`;
    
    let contentHtml = isUser ? `<p>${text}</p>` : text;
    
    div.innerHTML = `
        <div class="avatar"><i class="fa-solid ${isUser ? 'fa-user' : 'fa-robot'}"></i></div>
        <div class="msg-content">${contentHtml}</div>
    `;
    
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addLoadingMessage() {
    const div = document.createElement('div');
    div.className = 'message system-msg loading-msg';
    div.innerHTML = `
        <div class="avatar"><i class="fa-solid fa-robot"></i></div>
        <div class="msg-content">
            <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
}

sendBtn.addEventListener('click', async () => {
    const text = aiInput.value.trim();
    if (!text) return;

    aiInput.value = '';
    addMessage(text, true);
    
    const loadingEl = addLoadingMessage();

    try {
        // Since we decided to pass the API Key to the backend via POST instead of just env vars to make it dynamic
        // I will just use the hardcoded env var from backend right now, wait.
        // Actually, let me pass the key in the request headers (Authorization) 
        // Oh wait, the backend server.js uses process.env.GEMINI_API_KEY.
        // I should modify server.js slightly to accept it from headers or use process.env as fallback.
        // Let's send it in a header custom `X-API-KEY`.
        
        const res = await fetch('/api/transaction', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ description: text })
        });
        
        const data = await res.json();
        chatMessages.removeChild(loadingEl);
        
        if (!res.ok) {
            addMessage(`<span style="color:var(--text-secondary)">❌ Error: ${data.error}</span>`);
            return;
        }

        let tableHtml = `<p>✅ Transacción registrada exitosamente. Asientos:</p>`;
        tableHtml += `<table class="glass-table" style="margin-top:10px; font-size:13px; border-radius:8px; overflow:hidden">`;
        tableHtml += `<thead><tr><th>Cuenta</th><th>Débito</th><th>Crédito</th></tr></thead><tbody>`;
        
        data.entries.forEach(e => {
            tableHtml += `<tr>
                <td>${e.account_code}</td>
                <td class="amount">${formatCurrency(e.debit)}</td>
                <td class="amount">${formatCurrency(e.credit)}</td>
            </tr>`;
        });
        tableHtml += `</tbody></table>`;
        
        addMessage(tableHtml);
        
    } catch (e) {
        chatMessages.removeChild(loadingEl);
        addMessage(`<span style="color:#ef4444">Error de conexión: ${e.message}</span>`);
    }
});

aiInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
    }
});

// --- Help Chat Logic ---
const helpMessages = document.getElementById('help-messages');
const helpInput = document.getElementById('help-input');

function addHelpMessage(text, isUser = false) {
    const div = document.createElement('div');
    div.className = `message ${isUser ? 'user-msg' : 'system-msg'}`;
    
    // Parse markdown briefly for bold, italics, headers and newlines
    let html = text
        .replace(/### (.*)/g, '<br><strong>$1</strong>')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');

    let contentHtml = isUser ? `<p>${text}</p>` : html;
    
    div.innerHTML = `
        <div class="avatar"><i class="fa-solid ${isUser ? 'fa-user' : 'fa-graduation-cap'}"></i></div>
        <div class="msg-content" style="line-height:1.5;">${contentHtml}</div>
    `;
    
    helpMessages.appendChild(div);
    helpMessages.scrollTop = helpMessages.scrollHeight;
}

function addHelpLoadingMessage() {
    const div = document.createElement('div');
    div.className = 'message system-msg loading-msg';
    div.innerHTML = `
        <div class="avatar"><i class="fa-solid fa-graduation-cap"></i></div>
        <div class="msg-content">
            <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
    `;
    helpMessages.appendChild(div);
    helpMessages.scrollTop = helpMessages.scrollHeight;
    return div;
}

const helpSendBtn = document.getElementById('help-send-btn');

helpSendBtn.addEventListener('click', async () => {
    const msg = helpInput.value.trim();
    if (!msg) return;

    addHelpMessage(msg, true);
    helpInput.value = '';
    
    const loadingEl = addHelpLoadingMessage();

    try {
        const res = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: msg })
        });
        
        helpMessages.removeChild(loadingEl);
        
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            addHelpMessage(`<span style="color:var(--text-secondary)">❌ Error: ${data.error || 'Server Error'}</span>`);
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        
        const div = document.createElement('div');
        div.className = 'message system-msg';
        div.innerHTML = `
            <div class="avatar"><i class="fa-solid fa-graduation-cap"></i></div>
            <div class="msg-content" style="line-height:1.5;"></div>
        `;
        helpMessages.appendChild(div);
        const contentDiv = div.querySelector('.msg-content');
        
        const parseMd = (text) => text.replace(/### (.*)/g, '<br><strong>$1</strong>').replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>').replace(/\\n/g, '<br>');

        let fullText = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    if (dataStr === '[DONE]') break;
                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.error) {
                            contentDiv.innerHTML += `<span style="color:#ef4444"><br>Error: ${parsed.error}</span>`;
                            break;
                        }
                        if (parsed.text) {
                            fullText += parsed.text;
                            contentDiv.innerHTML = parseMd(fullText);
                            helpMessages.scrollTop = helpMessages.scrollHeight;
                        }
                    } catch(e) {}
                }
            }
        }
    } catch (e) {
        if(helpMessages.contains(loadingEl)) helpMessages.removeChild(loadingEl);
        addHelpMessage(`<span style="color:#ef4444">Error de conexión: ${e.message}</span>`);
    }
});

helpInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        helpSendBtn.click();
    }
});

// --- Ledger Logic ---
let currentLedgerData = [];

document.getElementById('refresh-ledger').addEventListener('click', fetchLedger);
document.getElementById('export-excel-btn').addEventListener('click', () => {
    window.location.href = '/api/export';
});

async function fetchLedger() {
    const tbody = document.getElementById('ledger-body');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;"><div class="typing-indicator" style="justify-content:center"><span></span><span></span><span></span></div></td></tr>';
    
    try {
        const res = await fetch('/api/ledger');
        const data = await res.json();
        currentLedgerData = data;
        
        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No hay transacciones registradas.</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        data.forEach(t => {
            const date = new Date(t.date).toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
            
            let html = `
                <tr>
                    <td rowspan="${t.entries.length}">${date}</td>
                    <td rowspan="${t.entries.length}">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
                            <span><b>#${t.id}</b> - <span id="desc-${t.id}">${t.description}</span></span>
                            <div style="display:flex; gap:6px; flex-shrink:0;">
                                <button class="btn-icon" style="width:28px;height:28px;font-size:12px;" onclick="promptEditTx(${t.id})" title="Editar concepto"><i class="fa-solid fa-pen"></i></button>
                                <button class="btn-icon" style="width:28px;height:28px;font-size:12px;color:#ef4444;" onclick="deleteTx(${t.id})" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                    </td>
            `;
            
            t.entries.forEach((e, index) => {
                if (index > 0) html += `<tr>`;
                
                const isDebit = e.debit > 0;
                const isCredit = e.credit > 0;
                
                html += `
                    <td><span class="badge badge-${isDebit ? 'debit' : 'credit'}">${e.account_code}</span></td>
                    <td>${e.account_name}</td>
                    <td class="amount" style="${isDebit ? 'color:var(--success)' : 'color:var(--text-secondary)'}">${isDebit ? formatCurrency(e.debit) : ''}</td>
                    <td class="amount" style="${isCredit ? 'color:var(--success)' : 'color:var(--text-secondary)'}">${isCredit ? formatCurrency(e.credit) : ''}</td>
                </tr>`;
            });
            
            tbody.innerHTML += html;
        });

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="6" style="color:red;text-align:center;">Error: ${e.message}</td></tr>`;
    }
}

// Transaction Actions
window.deleteTx = async (id) => {
    if(!confirm(`¿Estás seguro de que deseas eliminar permanentemente la transacción #${id}?`)) return;
    try {
        const res = await fetch(`/api/transaction/${id}`, { method: 'DELETE' });
        if(res.ok) {
            showToast(`Transacción #${id} eliminada.`);
            fetchLedger();
        } else {
            const data = await res.json();
            showToast(data.error || 'Error eliminando transacción', true);
        }
    } catch (e) {
        showToast('Error de conexión', true);
    }
};

let editingTxId = null;

window.promptEditTx = (id) => {
    const tx = currentLedgerData.find(t => t.id === id);
    if (!tx) return;
    
    editingTxId = id;
    document.getElementById('edit-tx-id').innerText = '#' + id;
    document.getElementById('edit-desc').value = tx.description;
    
    const container = document.getElementById('edit-entries-container');
    container.innerHTML = `
        <div style="display:grid; grid-template-columns: 2fr 1fr 1fr; gap:10px; font-size:12px; color:var(--text-secondary); margin-bottom:4px; padding:0 12px;">
            <span>Cuenta</span>
            <span style="text-align:right">Débito</span>
            <span style="text-align:right">Crédito</span>
        </div>
    `;
    
    tx.entries.forEach(e => {
        container.innerHTML += `
            <div class="edit-entry-row" data-entry-id="${e.entry_id}">
                <span style="font-size:13px" title="${e.account_code} - ${e.account_name}"><b>${e.account_code}</b> - ${e.account_name}</span>
                <input type="number" class="edit-debit" value="${e.debit}" oninput="calcEditTotals()">
                <input type="number" class="edit-credit" value="${e.credit}" oninput="calcEditTotals()">
            </div>
        `;
    });
    
    document.getElementById('edit-modal').classList.add('show');
    calcEditTotals();
};

window.closeEditModal = () => {
    document.getElementById('edit-modal').classList.remove('show');
    editingTxId = null;
};

window.calcEditTotals = () => {
    let totalDebit = 0;
    let totalCredit = 0;
    
    document.querySelectorAll('.edit-entry-row').forEach(row => {
        const d = parseFloat(row.querySelector('.edit-debit').value) || 0;
        const c = parseFloat(row.querySelector('.edit-credit').value) || 0;
        totalDebit += d;
        totalCredit += c;
    });
    
    const diff = Math.abs(totalDebit - totalCredit);
    const saveBtn = document.getElementById('save-edit-btn');
    const totalsDiv = document.getElementById('edit-totals');
    
    if (diff > 0.01) {
        totalsDiv.innerHTML = `<span style="color:#ef4444">Descuadre: ${formatCurrency(diff)}</span>`;
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        saveBtn.style.cursor = 'not-allowed';
    } else {
        totalsDiv.innerHTML = `<span style="color:#10b981">Partida Doble Ok (${formatCurrency(totalDebit)})</span>`;
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.style.cursor = 'pointer';
    }
};

window.saveEditTx = async () => {
    if (!editingTxId) return;
    
    const newDesc = document.getElementById('edit-desc').value.trim();
    if (!newDesc) return showToast('El concepto no puede estar vacío', true);
    
    const entries = [];
    document.querySelectorAll('.edit-entry-row').forEach(row => {
        entries.push({
            entry_id: row.getAttribute('data-entry-id'),
            debit: parseFloat(row.querySelector('.edit-debit').value) || 0,
            credit: parseFloat(row.querySelector('.edit-credit').value) || 0
        });
    });
    
    const saveBtn = document.getElementById('save-edit-btn');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = 'Guardando...';
    saveBtn.disabled = true;
    
    try {
        const res = await fetch(`/api/transaction/${editingTxId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: newDesc, entries })
        });
        
        saveBtn.innerText = originalText;
        saveBtn.disabled = false;
        
        if(res.ok) {
            showToast('Transacción actualizada exitosamente.');
            closeEditModal();
            fetchLedger();
        } else {
            const data = await res.json();
            showToast(data.error || 'Error editando', true);
        }
    } catch (e) {
        saveBtn.innerText = originalText;
        saveBtn.disabled = false;
        showToast('Error de conexión', true);
    }
};

// --- PUC Logic ---
async function fetchPUC() {
    const tbody = document.getElementById('puc-body');
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;"><div class="typing-indicator" style="justify-content:center"><span></span><span></span><span></span></div></td></tr>';
    
    try {
        const res = await fetch('/api/accounts');
        const data = await res.json();
        
        tbody.innerHTML = '';
        data.forEach(a => {
            let color = 'white';
            if(a.type === 'Activo') color = '#3b82f6';
            if(a.type === 'Pasivo') color = '#ef4444';
            if(a.type === 'Patrimonio') color = '#10b981';
            if(a.type === 'Ingresos') color = '#f59e0b';
            if(a.type === 'Gastos') color = '#8b5cf6';
            if(a.type === 'Costos') color = '#f43f5e';

            tbody.innerHTML += `
                <tr>
                    <td><b>${a.code}</b></td>
                    <td>${a.name}</td>
                    <td><span style="color:${color}; font-weight:600">${a.type}</span></td>
                    <td class="amount" style="${a.balance !== 0 ? 'color:white; font-weight:600;' : 'color:var(--text-secondary)'}">${formatCurrency(a.balance)}</td>
                </tr>
            `;
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" style="color:red;text-align:center;">Error: ${e.message}</td></tr>`;
    }
}

// --- Income Statement Logic ---
async function fetchIncomeStatement() {
    const container = document.getElementById('results-body');
    container.innerHTML = '<div style="text-align:center; padding: 40px;"><div class="typing-indicator" style="justify-content:center"><span></span><span></span><span></span></div><p style="margin-top:20px; color:var(--text-secondary);">Calculando Estado de Resultados...</p></div>';
    
    try {
        const res = await fetch('/api/accounts');
        const data = await res.json();
        
        let totalIngresos = 0;
        let totalGastos = 0;
        let totalCostos = 0;
        
        let htmlIngresos = '';
        let htmlGastos = '';
        let htmlCostos = '';
        
        data.forEach(a => {
            if(a.balance === 0) return; // Hide accounts with 0 balance
            
            const rowHtml = `
                <div class="report-row">
                    <span>${a.code} - ${a.name}</span>
                    <span class="amount">${formatCurrency(a.balance)}</span>
                </div>
            `;
            
            if(a.type === 'Ingresos') {
                totalIngresos += a.balance;
                htmlIngresos += rowHtml;
            } else if(a.type === 'Gastos') {
                totalGastos += a.balance;
                htmlGastos += rowHtml;
            } else if(a.type === 'Costos') {
                totalCostos += a.balance;
                htmlCostos += rowHtml;
            }
        });

        // Calculations
        const utilidadBruta = totalIngresos - totalCostos;
        const utilidadNeta = utilidadBruta - totalGastos;
        
        const isProfit = utilidadNeta >= 0;
        
        container.innerHTML = `
            <h2>Estado de Resultados Integral</h2>
            <p style="color:var(--text-secondary); margin-bottom: 30px; font-size:14px;">Acumulado a la fecha</p>

            <div class="report-section">
                <h3 style="color:#f59e0b;">Ingresos Operacionales</h3>
                ${htmlIngresos || '<div class="report-row" style="color:var(--text-secondary)">No hay ingresos registrados</div>'}
                <div class="report-subtotal">
                    <span>Total Ingresos Brutos</span>
                    <span>${formatCurrency(totalIngresos)}</span>
                </div>
            </div>

            <div class="report-section">
                <h3 style="color:#f43f5e;">Costos de Ventas / Operación</h3>
                ${htmlCostos || '<div class="report-row" style="color:var(--text-secondary)">No hay costos registrados</div>'}
                <div class="report-subtotal" style="color:#f43f5e">
                    <span>Total Costos</span>
                    <span>- ${formatCurrency(totalCostos)}</span>
                </div>
            </div>

            <div class="report-subtotal" style="background: rgba(255,255,255,0.1); margin: 30px 0; font-size:16px;">
                <span>UTILIDAD BRUTA</span>
                <span>${formatCurrency(utilidadBruta)}</span>
            </div>

            <div class="report-section">
                <h3 style="color:#8b5cf6;">Gastos Operacionales</h3>
                ${htmlGastos || '<div class="report-row" style="color:var(--text-secondary)">No hay gastos registrados</div>'}
                <div class="report-subtotal" style="color:#8b5cf6">
                    <span>Total Gastos</span>
                    <span>- ${formatCurrency(totalGastos)}</span>
                </div>
            </div>

            <div class="report-final-total ${isProfit ? 'profit' : 'loss'}">
                <span>${isProfit ? 'Utilidad del Ejercicio' : 'Pérdida del Ejercicio'}</span>
                <span>${formatCurrency(utilidadNeta)}</span>
            </div>
        `;

    } catch (e) {
        container.innerHTML = `<div style="color:red;text-align:center;padding:40px;">Error generando reporte: ${e.message}</div>`;
    }
}

// --- Document Generator Logic ---
const bookingForm = document.getElementById('booking-form');
if (bookingForm) {
    const handlePdfGeneration = async (type) => {
        const btnId = type === 'summary' ? 'generate-summary-btn' : (type === 'contract' ? 'generate-contract-btn' : 'generate-pagare-btn');
        const generateBtn = document.getElementById(btnId);
        const originalBtnHtml = generateBtn.innerHTML;
        
        generateBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Generando...';
        document.getElementById('generate-summary-btn').disabled = true;
        document.getElementById('generate-contract-btn').disabled = true;
        document.getElementById('generate-pagare-btn').disabled = true;

        const formData = {
            type: type, // 'summary' or 'contract'
            fechaReserva: document.getElementById('fechaReserva').value,
            nombreReserva: document.getElementById('nombreReserva').value,
            ccReserva: document.getElementById('ccReserva').value,
            personas: document.getElementById('personas').value,
            codigoReserva: document.getElementById('codigoReserva').value,
            direccionInmueble: document.getElementById('direccionInmueble').value,
            entrada: document.getElementById('entrada').value,
            salida: document.getElementById('salida').value,
            valorNocheAdicional: document.getElementById('valorNocheAdicional').value,
            valorTotalArriendo: document.getElementById('valorTotalArriendo').value,
            bonoReembolsable: document.getElementById('bonoReembolsable').value,
            aseo: document.getElementById('aseo').value,
            metodoPago: document.getElementById('metodoPago').value,
            // New fields
            emailReserva: document.getElementById('emailReserva').value,
            telReserva: document.getElementById('telReserva').value,
            emergenciaNombre: document.getElementById('emergenciaNombre').value,
            emergenciaTel: document.getElementById('emergenciaTel').value
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // Increased to 60s for long contracts

        try {
            const response = await fetch('/api/generate-booking-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) throw new Error('Error en la generación del PDF');

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const fileName = type === 'summary' ? 'Informe_Reserva' : (type === 'contract' ? 'Contrato_Alquiler' : 'Pagare_y_Carta');
            a.download = `${fileName}_${formData.nombreReserva.replace(/ /g, '_')}.pdf`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            showToast('PDF generado y descargado con éxito');
        } catch (error) {
            clearTimeout(timeoutId);
            console.error(error);
            if (error.name === 'AbortError') {
                showToast('La generación tomó demasiado tiempo. Inténtalo de nuevo.', true);
            } else {
                showToast('Error al generar el PDF', true);
            }
        } finally {
            generateBtn.innerHTML = originalBtnHtml;
            document.getElementById('generate-summary-btn').disabled = false;
            document.getElementById('generate-contract-btn').disabled = false;
            document.getElementById('generate-pagare-btn').disabled = false;
        }
    };

    document.getElementById('generate-summary-btn').addEventListener('click', () => handlePdfGeneration('summary'));
    document.getElementById('generate-contract-btn').addEventListener('click', () => handlePdfGeneration('contract'));
    document.getElementById('generate-pagare-btn').addEventListener('click', () => handlePdfGeneration('pagare'));
    
    // Prevent default form submit
    bookingForm.addEventListener('submit', (e) => e.preventDefault());
}
