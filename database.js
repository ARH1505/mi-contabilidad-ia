const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const fs = require('fs');

// Allow overriding the database path for cloud environments with Persistent Volumes (like Railway)
const dbPath = process.env.DB_PATH || path.join(__dirname, 'contabilidad.db');

// Migration logic: If we are in a cloud environment (Volume)
if (dbPath.startsWith('/data')) {
    const localDbPath = path.join(__dirname, 'contabilidad.db');
    const dbExistsInVolume = fs.existsSync(dbPath);
    const localDbExists = fs.existsSync(localDbPath);

    console.log(`[Migration] Checking: VolumeDB=${dbExistsInVolume}, LocalDB=${localDbExists}`);

    const forceMigration = process.env.FORCE_MIGRATION === 'true';

    // If it doesn't exist in Volume OR we are forcing it
    if (localDbExists && (!dbExistsInVolume || forceMigration)) {
        try {
            fs.copyFileSync(localDbPath, dbPath);
            console.log('[Migration] SUCCESS: Database copied to Volume mount (Forced OR New).');
        } catch (e) {
            console.error('[Migration] ERROR:', e.message);
        }
    } else if (!localDbExists) {
        console.log('[Migration] Skip: No local contabilidad.db found in /app root.');
    } else {
        console.log('[Migration] Skip: Database already exists. Set FORCE_MIGRATION=true to overwrite.');
    }
}

// Connect to SQLite DB
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Create accounts table (PUC)
        db.run(`CREATE TABLE IF NOT EXISTS accounts (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL
        )`);

        // Create transactions table
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            description TEXT NOT NULL
        )`);

        // Create journal entries table
        db.run(`CREATE TABLE IF NOT EXISTS journal_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_id INTEGER,
            account_code TEXT,
            debit REAL DEFAULT 0,
            credit REAL DEFAULT 0,
            FOREIGN KEY(transaction_id) REFERENCES transactions(id),
            FOREIGN KEY(account_code) REFERENCES accounts(code)
        )`);

        // Seed expanded Colombian PUC if empty
        db.get("SELECT COUNT(*) as count FROM accounts", (err, row) => {
            if (row.count === 0) {
                const stmt = db.prepare("INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)");
                const puc = [
                    ['1105', 'Caja', 'Activo'],
                    ['110505', 'Caja general', 'Activo'],
                    ['1110', 'Bancos', 'Activo'],
                    ['111005', 'Bancos nacionales', 'Activo'],
                    ['1305', 'Clientes', 'Activo'],
                    ['130505', 'Nacionales', 'Activo'],
                    ['1330', 'Anticipos y avances', 'Activo'],
                    ['1435', 'Mercancías no fabricadas por la empresa', 'Activo'],
                    ['1520', 'Maquinaria y equipo', 'Activo'],
                    ['1524', 'Equipo de oficina', 'Activo'],
                    ['1528', 'Equipo de computación y comunicación', 'Activo'],
                    ['1705', 'Gastos pagados por anticipado', 'Activo'],
                    ['2105', 'Bancos nacionales', 'Pasivo'],
                    ['2205', 'Proveedores nacionales', 'Pasivo'],
                    ['2320', 'A contratistas', 'Pasivo'],
                    ['2335', 'Costos y gastos por pagar', 'Pasivo'],
                    ['2365', 'Retención en la fuente', 'Pasivo'],
                    ['2408', 'Impuesto sobre las ventas por pagar (IVA)', 'Pasivo'],
                    ['2810', 'Depósitos recibidos', 'Pasivo'],
                    ['2815', 'Ingresos recibidos para terceros', 'Pasivo'],
                    ['3115', 'Aportes sociales', 'Patrimonio'],
                    ['3605', 'Utilidad del ejercicio', 'Patrimonio'],
                    ['3610', 'Pérdida del ejercicio', 'Patrimonio'],
                    ['4135', 'Comercio al por mayor y al por menor', 'Ingresos'],
                    ['4155', 'Actividades inmobiliarias, empresariales y de alquiler', 'Ingresos'],
                    ['415505', 'Actividades inmobiliarias (Comisiones)', 'Ingresos'],
                    ['415570', 'Comisiones por aseo', 'Ingresos'],
                    ['4175', 'Devoluciones en ventas', 'Ingresos'],
                    ['4210', 'Ingresos financieros (Rendimientos bancarios)', 'Ingresos'],
                    ['5105', 'Gastos de personal', 'Gastos'],
                    ['510506', 'Sueldos', 'Gastos'],
                    ['510568', 'Aportes administradora de riesgos', 'Gastos'],
                    ['510569', 'Aportes al I.S.S', 'Gastos'],
                    ['510570', 'Aportes a fondos de pensiones', 'Gastos'],
                    ['510572', 'Aportes cajas de compensacion familiar', 'Gastos'],
                    ['5115', 'Impuestos', 'Gastos'],
                    ['5120', 'Arrendamientos', 'Gastos'],
                    ['5130', 'Seguros', 'Gastos'],
                    ['5135', 'Servicios', 'Gastos'],
                    ['5145', 'Mantenimiento y reparaciones', 'Gastos'],
                    ['5195', 'Diversos', 'Gastos'],
                    ['5305', 'Gastos financieros', 'Gastos'],
                    ['530510', 'Gastos bancarios (GMF / 4x1000)', 'Gastos'],
                    ['5400', 'PERSONAL MILENA', 'Gastos'],
                    ['6135', 'Costo de comercio al por mayor y al por menor', 'Costos']
                ];
                puc.forEach(account => stmt.run(account));
                stmt.finalize();
                console.log("PUC accounts seeded.");
            }
        });
    });
}

module.exports = db;
