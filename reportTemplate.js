
function generateBookingReportTemplate(data) {
    const {
        fechaReserva,
        nombreReserva,
        ccReserva,
        personas,
        codigoReserva,
        direccionInmueble,
        entrada,
        salida,
        valorNocheAdicional,
        valorTotalArriendo,
        bonoReembolsable,
        aseo,
        metodoPago,
        logoBase64
    } = data;

    // Calculations
    const total = Number(valorTotalArriendo) + Number(aseo) + Number(bonoReembolsable);
    const valorReservacion = total * 0.3;
    const saldoEntrar = total - valorReservacion;

    const formatter = new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        minimumFractionDigits: 0
    });

    return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: 'Helvetica', 'Arial', sans-serif;
            color: #333;
            line-height: 1.4;
            margin: 0;
            padding: 40px;
            font-size: 11pt;
        }
        .header {
            text-align: center;
            margin-bottom: 20px;
        }
        .logo {
            max-width: 250px;
            margin-bottom: 10px;
        }
        h1 {
            font-size: 18pt;
            color: #1e1b4b;
            margin: 0;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        .info-grid {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        .info-grid td {
            padding: 5px;
            border-bottom: 1px solid #eee;
        }
        .label {
            font-weight: bold;
            color: #555;
            width: 40%;
        }
        .value {
            color: #000;
        }
        .highlight-box {
            background-color: #f3f4f6;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 5px solid #6366f1;
        }
        .financials {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        .financials td {
            padding: 8px;
        }
        .total-row {
            font-weight: bold;
            font-size: 13pt;
            background-color: #1e1b4b;
            color: white;
        }
        .footer {
            margin-top: 30px;
            font-size: 9pt;
            color: #666;
            text-align: center;
            border-top: 1px solid #ddd;
            padding-top: 15px;
        }
        .clauses {
            font-size: 9pt;
            text-align: justify;
            margin-top: 20px;
        }
        .clause-title {
            font-weight: bold;
            text-transform: uppercase;
            margin-bottom: 5px;
            display: block;
        }
        .page-break {
            page-break-after: always;
        }
    </style>
</head>
<body>
    <div class="header">
        <img src="${logoBase64}" class="logo">
        <h1>INFORME DE SU RESERVA</h1>
    </div>

    <table class="info-grid">
        <tr>
            <td class="label">Fecha de la Reserva:</td>
            <td class="value">${fechaReserva}</td>
        </tr>
        <tr>
            <td class="label">Nombre de la Reserva:</td>
            <td class="value">${nombreReserva}</td>
        </tr>
        <tr>
            <td class="label">C.C. / ID:</td>
            <td class="value">${ccReserva}</td>
        </tr>
        <tr>
            <td class="label">Número de Personas:</td>
            <td class="value">${personas}</td>
        </tr>
        <tr>
            <td class="label">CÓDIGO DE LA RESERVA:</td>
            <td class="value" style="font-family: monospace; font-weight: bold;">${codigoReserva}</td>
        </tr>
        <tr>
            <td class="label">Dirección del Inmueble:</td>
            <td class="value">${direccionInmueble}</td>
        </tr>
        <tr>
            <td class="label">Fecha de Entrada:</td>
            <td class="value">${entrada}</td>
        </tr>
        <tr>
            <td class="label">Fecha de Salida:</td>
            <td class="value">${salida}</td>
        </tr>
    </table>

    <div class="highlight-box">
        <table class="financials">
            <tr>
                <td>Valor noche Adicional:</td>
                <td style="text-align: right">${formatter.format(valorNocheAdicional)}</td>
            </tr>
            <tr>
                <td>Valor total del Arriendo mensual:</td>
                <td style="text-align: right">${formatter.format(valorTotalArriendo)}</td>
            </tr>
            <tr>
                <td>BONO REEMBOLSABLE (pérdidas o daños):</td>
                <td style="text-align: right">${formatter.format(bonoReembolsable)}</td>
            </tr>
            <tr>
                <td>Aseo:</td>
                <td style="text-align: right">${formatter.format(aseo)}</td>
            </tr>
            <tr class="total-row">
                <td>VALOR TOTAL:</td>
                <td style="text-align: right">${formatter.format(total)}</td>
            </tr>
        </table>
    </div>

    <table class="info-grid">
         <tr>
            <td class="label">Valor para reservación (30%):</td>
            <td class="value" style="color: #ef4444; font-weight: bold;">${formatter.format(valorReservacion)}</td>
        </tr>
        <tr>
            <td class="label">Saldo pendiente al entrar:</td>
            <td class="value" style="font-weight: bold;">${formatter.format(saldoEntrar)}</td>
        </tr>
    </table>

    <div class="clauses">
        <p>De los cuales <b>${formatter.format(bonoReembolsable)}</b> son reembolsables al revisar el inventario y estar al día.</p>
        <p>La comisión de la consignación cobrada por el banco deberá ser paga por el huésped. En el momento de la llegada se debe cancelar la totalidad del dinero.</p>
        
        <span class="clause-title">Aceptación de las Condiciones</span>
        <p>El ARRENDATARIO declara haber leído, comprendido y aceptado las políticas de cancelación y reembolso. Se entiende que el 30% pagado por concepto de reserva NO es reembolsable.</p>
        
        <span class="clause-title">Aceptación por Silencio</span>
        <p>Una vez enviado este documento, si no existe respuesta u objeción dentro de las 24 horas, se entenderá que el ARRENDATARIO acepta en su totalidad el contenido enviado.</p>
        
        <span class="clause-title">Método de Pago</span>
        <p>${metodoPago}</p>
        <p>BANCOLOMBIA CUENTA DE AHORROS # 02046147939</p>
    </div>

    <div class="footer">
        <p>Calle 32 32-64 local 11 CC. Riviera Plaza Bucaramanga</p>
        <p>Tel: 3167583928 - 3165791058 - 6076744033 | rentahouse01@hotmail.com</p>
    </div>
</body>
</html>
    `;
}

module.exports = { generateBookingReportTemplate };
