const { GoogleGenAI } = require('@google/genai');

async function processAccountingMovement(description, apiKey, dbAccounts) {
    if (!apiKey) {
        throw new Error("API Key de Google Gemini no configurada.");
    }
    const ai = new GoogleGenAI({ apiKey: apiKey });
    
    // Convert accounts to a string for the prompt
    const accountsInfo = dbAccounts.map(a => `${a.code} - ${a.name} (${a.type})`).join('\n');

    const systemPrompt = `
Eres un Contador Público Colombiano Experto. Tu trabajo es analizar un movimiento comercial descrito en lenguaje natural y generar el asiento contable correspondiente usando el principio de partida doble.

A continuación tienes una lista simplificada del Plan Único de Cuentas (PUC) de la empresa:
${accountsInfo}

Lee la siguiente transacción descrita por el usuario:
"${description}"

Devuelve ÚNICAMENTE un objeto JSON válido con la siguiente estructura (NO incluyas markdown, ni explicación, solo el JSON puro):
{
  "entries": [
    {
      "account_code": "código de la cuenta",
      "debit": monto numérico (si aplica, sino 0),
      "credit": monto numérico (si aplica, sino 0)
    }
  ]
}

Reglas Generales:
- La suma de los créditos (credit) debe ser exactamente igual a la suma de los débitos (debit).
- Usa los códigos de cuenta exactos de la lista proporcionada. Si consideras que falta una cuenta, asume la más cercana de la lista anterior.
- Los montos deben ser números (sin comas de formato).

Reglas Específicas de la Empresa (Inmobiliaria):
- Si el usuario dice "bancos" o "transferencia" o "consignación", usa ESTRICTAMENTE la cuenta 1110 (Bancos) y NO otra (ni 111005).
- Si el usuario dice "efectivo" o "caja", usa ESTRICTAMENTE la cuenta 1105 (Caja) y NO otra.
- Cuando el usuario indique que ingresó un "canon" de arrendamiento:
  1. SIEMPRE debes dividir el ingreso en dos partes en el Crédito:
     a. El monto destinado al propietario: Cuenta 2815 (Ingresos Recibidos Para Terceros) [Crédito].
     b. La comisión de la inmobiliaria: Cuenta 415505 (Actividades Inmobiliarias - Comisiones) [Crédito].
  2. El usuario indicará cuánto corresponde a cada parte. Si NO lo indica, prioriza preguntar o buscar coherencia, pero NO inventes porcentajes fijos si no vienen del usuario.
  3. El total de estas dos cuentas debe cuadrar con el ingreso a Bancos (1110) [Débito].
- Cuando haya "depósitos que se devuelven al cliente al finalizar la reserva", llévalos a la cuenta 2810 (Depósitos Recibidos) en el Crédito (si ingresan) o Débito (si se devuelven).
- Cuando el usuario indique que la empresa comisionó o cobró un valor a favor de la empresa por "aseo", la ganancia llévala a 415570 (Comisiones por aseo) en el Crédito.
- Cuando el usuario indique que la empresa PAGA por el concepto de "aseo" de un apartamento, ese pago plásmalo afectando la cuenta 2320 (A contratistas).
- El 4x1000 o Gravamen a Movimientos Financieros (GMF) se debe cargar a la cuenta 530510.
- Siempre cuadra la partida doble con exactitud usando esta lógica.

Devuelve ÚNICAMENTE un objeto JSON válido con la siguiente estructura (NO incluyas markdown, ni explicación, solo el JSON puro):
{
  "entries": [
    {
      "account_code": "código de la cuenta",
      "debit": monto numérico (si aplica, sino 0),
      "credit": monto numérico (si aplica, sino 0)
    }
  ]
}
`;

    const userPrompt = `Lee la siguiente transacción descrita por el usuario: "${description}"`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.1,
                responseMimeType: "application/json",
            }
        });

        const data = JSON.parse(response.text);
        return data.entries;
    } catch (error) {
        throw new Error("Error en la IA: " + error.message);
    }
}

async function askAccountingQuestionStream(question, apiKey) {
    const ai = new GoogleGenAI({ apiKey: apiKey });

    const systemPrompt = `
Eres un experto Contador Público y Asesor Tributario de Colombia. 
Tu labor es responder consultas, explicar conceptos contables, y dar consejos sobre el manejo financiero y tributario a usuarios de una inmobiliaria.
Debes comunicarte de forma profesional, pedagógica, clara y amable. 
Utiliza el Plan Único de Cuentas (PUC) de Colombia como referencia cuando sea necesario.
No devuelvas JSON, responde en lenguaje natural (texto plano o markdown) simulando una conversación fluida.
    `;

    try {
        const responseStream = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: question }] }],
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.5,
            }
        });

        return responseStream;
    } catch (error) {
        throw new Error("Error en el asesor IA: " + error.message);
    }
}

module.exports = { processAccountingMovement, askAccountingQuestionStream };
