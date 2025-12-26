const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DATABASE CONNECTION (Updated to Connection Pool for Stability)
// 'createPool' automatically reconnects if the DB connection is lost (common on Render/TiDB)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com', 
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER || '2mEE8MFQ91iN7ye.root', 
    password: process.env.DB_PASSWORD || 'tGU9ocbnUjlt4d5V', 
    database: process.env.DB_NAME || 'qmaze_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: { 
        minVersion: 'TLSv1.2', 
        rejectUnauthorized: false 
    }
});

// Test Connection and Initialize Tables
db.getConnection((err, connection) => {
    if (err) {
        console.error('DB Connection Failed:', err.message);
    } else {
        console.log('TiDB Connected Successfully via Pool.');
        
        // Initialize Tables
        initializeTables(connection);
        
        // Release the connection back to the pool
        connection.release();
    }
});

function initializeTables(conn) {
    // Users Table
    const usersTableSQL = `
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL
        )
    `;

    // Level Times Table
    const levelTimesTableSQL = `
        CREATE TABLE IF NOT EXISTS level_times (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            level_id INT NOT NULL,
            time_spent FLOAT,
            points INT,
            correct INT,
            wrong INT,
            wrong_penalty FLOAT,
            cheat_penalty FLOAT,
            UNIQUE KEY user_level_unique (username, level_id)
        )
    `;

    conn.query(usersTableSQL);
    conn.query(levelTimesTableSQL);
}

// --- ROUTES ---

// 1. REGISTER
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");

    try {
        const hashed = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed], (err) => {
            if (err) {
                console.error("Register DB Error:", err);
                return res.status(400).send("User exists or error");
            }
            res.status(201).send("Registered");
        });
    } catch (e) {
        res.status(500).send("Server error");
    }
});

// 2. LOGIN
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err || results.length === 0) return res.status(401).send("Not found");
        const valid = await bcrypt.compare(password, results[0].password);
        if (!valid) return res.status(401).send("Wrong pass");
        res.status(200).send("Success");
    });
});

// 3. SAVE LEVEL TIME
app.post('/save-time', (req, res) => {
    const { username, level_id, time_spent, points, correct, wrong, wrong_penalty, cheat_penalty } = req.body;
    if (!username || !level_id) return res.status(400).send("Missing data");

    const query = `INSERT INTO level_times (username, level_id, time_spent, points, correct, wrong, wrong_penalty, cheat_penalty) 
                   VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE 
                   time_spent=VALUES(time_spent), points=VALUES(points), correct=VALUES(correct), 
                   wrong=VALUES(wrong), wrong_penalty=VALUES(wrong_penalty), cheat_penalty=VALUES(cheat_penalty)`;
    
    db.query(query, [username, level_id, time_spent, points, correct, wrong, wrong_penalty, cheat_penalty], (err) => {
        if (err) {
            console.error("Save Error:", err.message); // Added logging
            return res.status(500).send("Save Fail");
        }
        res.status(200).send("Saved");
    });
});

// 4. GET USER RESULTS
app.get('/user-results/:username', (req, res) => {
    db.query('SELECT * FROM level_times WHERE username = ? ORDER BY level_id ASC', [req.params.username], (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

// 5. RESET PROGRESS
app.post('/reset-progress', (req, res) => {
    db.query('DELETE FROM level_times WHERE username = ?', [req.body.username], (err) => {
        if (err) return res.status(500).send("Reset Fail");
        res.status(200).send("Reset Done");
    });
});

// --- NEW ADMIN ENDPOINTS ---

// 6. GET ALL RESULTS (For Admin Dashboard)
app.get('/admin/all-results', (req, res) => {
    // Fetches all records, sorted by Level then by Points (High to Low), then Time (Low to High)
    const query = 'SELECT * FROM level_times ORDER BY level_id ASC, points DESC, time_spent ASC';
    db.query(query, (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

// 7. GET SYSTEM STATS
app.get('/admin/stats', (req, res) => {
    const q1 = new Promise((resolve, reject) => {
        db.query('SELECT COUNT(*) as count FROM users', (err, r) => err ? reject(err) : resolve(r[0].count));
    });
    const q2 = new Promise((resolve, reject) => {
        db.query('SELECT COUNT(*) as count FROM level_times', (err, r) => err ? reject(err) : resolve(r[0].count));
    });

    Promise.all([q1, q2])
        .then(([userCount, playsCount]) => res.json({ userCount, playsCount }))
        .catch(err => res.status(500).json({ error: err.message }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
