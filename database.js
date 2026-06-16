const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./djs.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS djs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    url TEXT,
    country TEXT,
    socialMediaUrls TEXT,
    musicStyles TEXT,
    lastUpdated DATE,
    emails TEXT,
    UNIQUE(name, url)
  )`, (err) => {
    if (err) {
      console.error('Error creating table:', err.message);
    }
  });

  db.all("PRAGMA table_info(djs)", (err, rows) => {
    if (err) {
      console.error('Error checking table schema:', err.message);
    } else {
      const columns = rows.map(row => row.name);
      if (!columns.includes('lastUpdated')) {
        db.run("ALTER TABLE djs ADD COLUMN lastUpdated DATE", (err) => {
          if (err) {
            console.error('Error adding column lastUpdated:', err.message);
          }
        });
      }
      if (!columns.includes('emails')) {
        db.run("ALTER TABLE djs ADD COLUMN emails TEXT", (err) => {
          if (err) {
            console.error('Error adding column emails:', err.message);
          }
        });
      }
    }
  });
});

function insertDJ(name, url) {
  return new Promise((resolve, reject) => {
    db.run("INSERT OR IGNORE INTO djs (name, url) VALUES (?, ?)", [name, url], function(err) {
      if (err) {
        console.error(`Error inserting DJ: ${name}, ${url} - ${err.message}`);
        reject(err);
      } else {
        console.log(`Successfully inserted DJ: ${name}, ${url}`);
        resolve(this.lastID);
      }
    });
  });
}

function checkDJExists(name, url) {
  return new Promise((resolve, reject) => {
    db.get("SELECT 1 FROM djs WHERE name = ? AND url = ?", [name, url], (err, row) => {
      if (err) {
        console.error(`Error checking if DJ exists: ${name}, ${url} - ${err.message}`);
        reject(err);
      } else {
        resolve(!!row);
      }
    });
  });
}

function updateDJ(id, country, socialMediaUrls, musicStyles, emails) {
  return new Promise((resolve, reject) => {
    db.run(
      "UPDATE djs SET country = ?, socialMediaUrls = ?, musicStyles = ?, emails = ?, lastUpdated = DATE('now') WHERE id = ?",
      [country, socialMediaUrls, musicStyles, emails, id],
      function(err) {
        if (err) {
          console.error(`Error updating DJ: ${id} - ${err.message}`);
          reject(err);
        } else {
          console.log(`Successfully updated DJ: ${id}`);
          resolve();
        }
      }
    );
  });
}

function getAllDJs(filters = {}) {
  return new Promise((resolve, reject) => {
    let query = "SELECT * FROM djs";
    const params = [];

    if (filters.search) {
      query += " WHERE name LIKE ? OR country LIKE ? OR musicStyles LIKE ?";
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    db.all(query, params, (err, rows) => {
      if (err) {
        console.error(`Error retrieving all DJs: ${err.message}`);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function getDJsToUpdate() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT * FROM djs WHERE lastUpdated IS NULL OR lastUpdated < DATE('now', '-28 days')",
      [],
      (err, rows) => {
        if (err) {
          console.error(`Error retrieving DJs to update: ${err.message}`);
          reject(err);
        } else {
          resolve(rows);
        }
      }
    );
  });
}

function getUniqueCountries() {
  return new Promise((resolve, reject) => {
    db.all("SELECT DISTINCT country FROM djs", [], (err, rows) => {
      if (err) {
        console.error(`Error retrieving unique countries: ${err.message}`);
        reject(err);
      } else {
        const uniqueCountries = rows.flatMap(row => JSON.parse(row.country || '[]'));
        resolve([...new Set(uniqueCountries)]);
      }
    });
  });
}

function getUniqueStyles() {
  return new Promise((resolve, reject) => {
    db.all("SELECT DISTINCT musicStyles FROM djs", [], (err, rows) => {
      if (err) {
        console.error(`Error retrieving unique music styles: ${err.message}`);
        reject(err);
      } else {
        const uniqueStyles = rows.flatMap(row => JSON.parse(row.musicStyles || '[]'));
        resolve([...new Set(uniqueStyles)]);
      }
    });
  });
}

function getDJCount() {
  return new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM djs", (err, row) => {
      if (err) {
        console.error('Error getting DJ count:', err.message);
        reject(err);
      } else {
        resolve(row.count);
      }
    });
  });
}

function getSearchableDJCount() {
  return new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM djs WHERE lastUpdated IS NOT NULL", (err, row) => {
      if (err) {
        console.error('Error getting searchable DJ count:', err.message);
        reject(err);
      } else {
        resolve(row.count);
      }
    });
  });
}

function getDJStats() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM djs", [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const total = rows.length;
        const withAdditionalData = rows.filter(dj => dj.lastUpdated).length;
        resolve({ total, withAdditionalData });
      }
    });
  });
}

function getDJsWithEmailsCount() {
  return new Promise((resolve, reject) => {
    db.all('SELECT COUNT(*) AS count FROM djs WHERE emails IS NOT NULL AND emails <> "" AND emails != "[]"', [], (err, rows) => {
      if (err) {
        console.error("Error executing query:", err.message);
        reject(err);
      } else {
        const count = rows[0] ? rows[0].count : 0;
        console.log("Count:", count);
        resolve(count);
      }
    });
  });
}

module.exports = {
  insertDJ,
  checkDJExists,
  updateDJ,
  getAllDJs,
  getDJsToUpdate,
  getUniqueCountries,
  getUniqueStyles,
  getDJCount,
  getSearchableDJCount,
  getDJStats,
  getDJsWithEmailsCount
};
