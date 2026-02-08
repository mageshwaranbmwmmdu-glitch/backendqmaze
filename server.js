const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DATABASE CONNECTION (Connection Pool)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com', 
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER || '2mEE8MFQ91iN7ye.root', 
    password: process.env.DB_PASSWORD || 'tGU9ocbnUjlt4d5V', 
    database: process.env.DB_NAME || 'qmaze_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false }
});

// Init DB
db.getConnection((err, connection) => {
    if (err) {
        console.error('DB Connection Failed:', err.message);
    } else {
        console.log('TiDB Connected Successfully via Pool.');
        initializeTables(connection);
        connection.release();
    }
});

function initializeTables(conn) {
    const usersTableSQL = `
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            login_count INT DEFAULT 0
        )
    `;

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

    conn.query(usersTableSQL, (err) => {
        if (!err) {
            conn.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INT DEFAULT 0");
        }
    });
    conn.query(levelTimesTableSQL);
}

// --- ROUTES ---

// 1. REGISTER
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");

    try {
        const hashed = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password, login_count) VALUES (?, ?, 0)', [username, hashed], (err) => {
            if (err) return res.status(400).send("User exists or error");
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
        
        db.query('UPDATE users SET login_count = login_count + 1 WHERE id = ?', [results[0].id]);

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
        if (err) return res.status(500).send("Save Fail");
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

// --- ADMIN ROUTES ---

// 6. CREATE USER
app.post('/admin/create-user', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });

    try {
        const hashed = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password, login_count) VALUES (?, ?, 0)', [username, hashed], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: "Username already exists" });
                return res.status(500).json({ error: "Database error" });
            }
            res.status(201).json({ message: "User created successfully" });
        });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

// 7. GET ALL RESULTS
app.get('/admin/all-results', (req, res) => {
    const query = `
        SELECT lt.*, u.login_count 
        FROM level_times lt 
        JOIN users u ON lt.username = u.username 
        ORDER BY lt.level_id ASC, lt.points DESC, lt.time_spent ASC
    `;
    db.query(query, (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

// 8. GET STATS
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

// 9. GET ALL USERS (Simple list for removal menu)
app.get('/admin/users', (req, res) => {
    db.query('SELECT id, username, login_count FROM users ORDER BY id ASC', (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

// 10. DELETE USER
app.delete('/admin/user/:username', (req, res) => {
    const username = req.params.username;
    
    // 1. Delete gameplay data
    db.query('DELETE FROM level_times WHERE username = ?', [username], (err) => {
        if (err) {
            console.error("Delete level_times error:", err);
            return res.status(500).json({ error: "Failed to clear user data" });
        }
        
        // 2. Delete user account
        db.query('DELETE FROM users WHERE username = ?', [username], (err, result) => {
            if (err) {
                console.error("Delete user error:", err);
                return res.status(500).json({ error: "Failed to delete user account" });
            }
            res.status(200).json({ message: "User deleted successfully" });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
