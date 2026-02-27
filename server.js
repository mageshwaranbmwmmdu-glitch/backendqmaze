const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DATABASE CONNECTION
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
    // 1. USERS TABLE
    const usersTableSQL = `
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            login_count INT DEFAULT 0,
            level_flow VARCHAR(255),
            current_level INT DEFAULT 1
        )
    `;

    // 2. LEVEL TIMES TABLE
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
            match_log TEXT,
            clue_log TEXT,
            level_flow VARCHAR(255),
            UNIQUE KEY user_level_unique (username, level_id)
        )
    `;

    // 3. GAME FEEDBACK TABLE (NEW)
    const feedbackTableSQL = `
        CREATE TABLE IF NOT EXISTS game_feedback (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255),
            rating_app INT,
            rating_clues INT,
            rating_venue INT,
            rating_ground INT,
            rating_vibe INT,
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    // 4. GAME SUGGESTIONS TABLE (NEW)
    const suggestionsTableSQL = `
        CREATE TABLE IF NOT EXISTS game_suggestions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255),
            suggestion_text TEXT,
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    conn.query(usersTableSQL, (err) => {
        if (!err) {
            // MIGRATION: Add new columns to users if they don't exist
            conn.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INT DEFAULT 0");
            conn.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS level_flow VARCHAR(255)");
            conn.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS current_level INT DEFAULT 1");
        }
    });

    conn.query(levelTimesTableSQL, (err) => {
        if (!err) {
            conn.query("ALTER TABLE level_times ADD COLUMN IF NOT EXISTS match_log TEXT");
            conn.query("ALTER TABLE level_times ADD COLUMN IF NOT EXISTS clue_log TEXT");
            conn.query("ALTER TABLE level_times ADD COLUMN IF NOT EXISTS level_flow VARCHAR(255)");
        }
    });

    // Execute New Table Creations
    conn.query(feedbackTableSQL, (err) => {
        if (err) console.error("Error creating game_feedback table:", err.message);
    });

    conn.query(suggestionsTableSQL, (err) => {
        if (err) console.error("Error creating game_suggestions table:", err.message);
    });
}

// --- ROUTES ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Missing fields");
    try {
        const hashed = await bcrypt.hash(password, 10);
        // Removed defaultFlow - User now starts with a null flow until first level completes/saves
        db.query('INSERT INTO users (username, password, login_count, current_level) VALUES (?, ?, 0, 1)', 
            [username, hashed], (err) => {
            if (err) return res.status(400).send("User exists or error");
            res.status(201).send("Registered");
        });
    } catch (e) { res.status(500).send("Server error"); }
});

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

app.post('/save-time', (req, res) => {
    const { 
        username, level_id, time_spent, points, correct, wrong, 
        wrong_penalty, cheat_penalty, match_log, clue_log, level_flow 
    } = req.body;
    
    if (!username || !level_id) return res.status(400).send("Missing data");

    // 1. Save Level Data
    const query = `INSERT INTO level_times 
                   (username, level_id, time_spent, points, correct, wrong, wrong_penalty, cheat_penalty, match_log, clue_log, level_flow) 
                   VALUES (?,?,?,?,?,?,?,?,?,?,?) 
                   ON DUPLICATE KEY UPDATE 
                   time_spent=VALUES(time_spent), points=VALUES(points), correct=VALUES(correct), 
                   wrong=VALUES(wrong), wrong_penalty=VALUES(wrong_penalty), cheat_penalty=VALUES(cheat_penalty),
                   match_log=VALUES(match_log), clue_log=VALUES(clue_log), level_flow=VALUES(level_flow)`;
    
    const params = [
        username, level_id, time_spent, points, correct, wrong, 
        wrong_penalty, cheat_penalty, 
        match_log || "", clue_log || "", level_flow || ""
    ];

    db.query(query, params, (err) => {
        if (err) {
            console.error("Save Error:", err.message);
            return res.status(500).send("Save Fail");
        }
        
        // 2. Update User's Current Level & Flow (Assuming successful save means level complete)
        const nextLevel = parseInt(level_id) + 1;
        db.query('UPDATE users SET current_level = GREATEST(current_level, ?), level_flow = ? WHERE username = ?', 
            [nextLevel, level_flow || "", username]);

        res.status(200).send("Saved");
    });
});

app.get('/user-results/:username', (req, res) => {
    db.query('SELECT * FROM level_times WHERE username = ? ORDER BY level_id ASC', [req.params.username], (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

app.post('/reset-progress', (req, res) => {
    const { username } = req.body;
    db.query('DELETE FROM level_times WHERE username = ?', [username], (err) => {
        if (err) return res.status(500).send("Reset Fail");
        db.query('UPDATE users SET current_level = 1, level_flow = NULL WHERE username = ?', [username]); // Reset level
        res.status(200).send("Reset Done");
    });
});


// --- ADMIN ROUTES ---

app.post('/admin/create-user', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    try {
        const hashed = await bcrypt.hash(password, 10);
        // No default flow string, leave it to take its default (NULL) until they play
        db.query('INSERT INTO users (username, password, login_count, current_level) VALUES (?, ?, 0, 1)', 
            [username, hashed], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: "Username already exists" });
                return res.status(500).json({ error: "Database error" });
            }
            res.status(201).json({ message: "User created successfully" });
        });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.get('/admin/all-results', (req, res) => {
    const query = `SELECT lt.*, u.login_count, u.current_level, u.level_flow as user_flow FROM level_times lt JOIN users u ON lt.username = u.username ORDER BY lt.level_id ASC, lt.points DESC, lt.time_spent ASC`;
    db.query(query, (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

app.get('/admin/stats', (req, res) => {
    const q1 = new Promise((resolve, reject) => db.query('SELECT COUNT(*) as count FROM users', (err, r) => err ? reject(err) : resolve(r[0].count)));
    const q2 = new Promise((resolve, reject) => db.query('SELECT COUNT(*) as count FROM level_times', (err, r) => err ? reject(err) : resolve(r[0].count)));
    Promise.all([q1, q2]).then(([userCount, playsCount]) => res.json({ userCount, playsCount })).catch(err => res.status(500).json({ error: err.message }));
});

app.get('/admin/users', (req, res) => {
    db.query('SELECT id, username, login_count, level_flow, current_level FROM users ORDER BY id ASC', (err, results) => {
        if (err) return res.status(500).send("DB Error");
        res.status(200).json(results);
    });
});

app.delete('/admin/user/:username', (req, res) => {
    const username = req.params.username;
    db.query('DELETE FROM level_times WHERE username = ?', [username], (err) => {
        if (err) return res.status(500).json({ error: "Failed to clear user data" });
        db.query('DELETE FROM users WHERE username = ?', [username], (err, result) => {
            if (err) return res.status(500).json({ error: "Failed to delete user account" });
            res.status(200).json({ message: "User deleted successfully" });
        });
    });
});

app.post('/admin/user/:username/reset-login', (req, res) => {
    const username = req.params.username;
    db.query('UPDATE users SET login_count = 0 WHERE username = ?', [username], (err, result) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.status(200).json({ message: "Login count reset to 0" });
    });
});


// --- FEEDBACK & SUGGESTIONS ROUTES ---

app.get('/admin/feedbacks', (req, res) => {
    db.query('SELECT * FROM game_feedback ORDER BY submitted_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.status(200).json(results);
    });
});

app.get('/admin/suggestions', (req, res) => {
    db.query('SELECT * FROM game_suggestions ORDER BY submitted_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.status(200).json(results);
    });
});

app.post('/api/feedback', (req, res) => {
    const { username, rating_app, rating_clues, rating_venue, rating_ground, rating_vibe } = req.body;
    
    const query = `
        INSERT INTO game_feedback 
        (username, rating_app, rating_clues, rating_venue, rating_ground, rating_vibe) 
        VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    db.query(query, [username, rating_app, rating_clues, rating_venue, rating_ground, rating_vibe], (err, result) => {
        if (err) {
            console.error("Error saving feedback:", err);
            return res.status(500).json({ error: "Failed to submit feedback" });
        }
        res.status(201).json({ message: "Feedback submitted successfully!" });
    });
});

app.post('/api/suggestions', (req, res) => {
    const { username, suggestion_text } = req.body;
    
    const query = 'INSERT INTO game_suggestions (username, suggestion_text) VALUES (?, ?)';
    
    db.query(query, [username, suggestion_text], (err, result) => {
        if (err) {
            console.error("Error saving suggestion:", err);
            return res.status(500).json({ error: "Failed to submit suggestion" });
        }
        res.status(201).json({ message: "Suggestion submitted successfully!" });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
