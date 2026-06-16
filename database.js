const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'djs.db');
const db = new sqlite3.Database(DB_PATH);

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAGIC_EMAILER_SYNC_STATUSES = [
  'pending',
  'synced',
  'failed',
  'skipped',
  'skipped_already_exists'
];

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function parseJsonValue(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function cleanEmail(value) {
  const email = String(value || '')
    .trim()
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .toLowerCase();
  return emailPattern.test(email) ? email : '';
}

function normalizeContactName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const url = new URL(text);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch (error) {
    return text.replace(/\/+$/, '');
  }
}

function cleanStringArray(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
  ));
}

function cleanUrlArray(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map(normalizeUrl)
      .filter(Boolean)
  ));
}

function isRoleEmail(email) {
  const localPart = String(email || '').split('@')[0];
  return [
    'admin',
    'booking',
    'bookings',
    'contact',
    'hello',
    'info',
    'mail',
    'management',
    'manager',
    'office',
    'press',
    'team'
  ].includes(localPart);
}

function createMagicEmailerSyncTableSql(tableName = 'magic_emailer_sync') {
  const statuses = MAGIC_EMAILER_SYNC_STATUSES.map(status => `'${status}'`).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    email TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN (${statuses})),
    payload TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    synced_at TEXT,
    retry_after TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;
}

function createMagicEmailerSyncIndexes() {
  db.run("CREATE INDEX IF NOT EXISTS idx_magic_emailer_sync_status ON magic_emailer_sync(status, updated_at)", (err) => {
    if (err) {
      console.error('Error creating magic_emailer_sync status index:', err.message);
    }
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_magic_emailer_sync_retry_after ON magic_emailer_sync(status, retry_after)", (err) => {
    if (err) {
      console.error('Error creating magic_emailer_sync retry_after index:', err.message);
    }
  });
}

function addMagicEmailerRetryAfterColumn() {
  db.run("ALTER TABLE magic_emailer_sync ADD COLUMN retry_after TEXT", (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.error('Error adding magic_emailer_sync retry_after column:', err.message);
    }
  });
}

function migrateMagicEmailerSyncStatuses(hasRetryAfter) {
  const backupTable = `magic_emailer_sync_backup_${Date.now()}`;
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    db.run(`ALTER TABLE magic_emailer_sync RENAME TO ${backupTable}`);
    db.run(createMagicEmailerSyncTableSql('magic_emailer_sync'));
    db.run(
      `INSERT INTO magic_emailer_sync (
         email,
         status,
         payload,
         attempts,
         last_error,
         synced_at,
         retry_after,
         created_at,
         updated_at
       )
       SELECT
         email,
         CASE
           WHEN status IN (${MAGIC_EMAILER_SYNC_STATUSES.map(status => `'${status}'`).join(', ')}) THEN status
           ELSE 'pending'
         END,
         payload,
         attempts,
         last_error,
         synced_at,
         ${hasRetryAfter ? 'retry_after' : 'NULL'},
         created_at,
         updated_at
       FROM ${backupTable}`
    );
    db.run(`DROP TABLE ${backupTable}`);
    db.run("COMMIT", (err) => {
      if (err) {
        console.error('Error migrating magic_emailer_sync table:', err.message);
        db.run("ROLLBACK");
      } else {
        createMagicEmailerSyncIndexes();
      }
    });
  });
}

function ensureMagicEmailerSyncSchema() {
  db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'magic_emailer_sync'", (err, row) => {
    if (err) {
      console.error('Error reading magic_emailer_sync schema:', err.message);
      return;
    }

    db.all("PRAGMA table_info(magic_emailer_sync)", (tableErr, rows) => {
      if (tableErr) {
        console.error('Error checking magic_emailer_sync columns:', tableErr.message);
        return;
      }

      const tableSql = row?.sql || '';
      const columns = rows.map(column => column.name);
      const hasRetryAfter = columns.includes('retry_after');
      const needsStatusMigration = tableSql && !tableSql.includes("'skipped_already_exists'");

      if (needsStatusMigration) {
        migrateMagicEmailerSyncStatuses(hasRetryAfter);
        return;
      }

      if (!hasRetryAfter) {
        addMagicEmailerRetryAfterColumn();
      }

      createMagicEmailerSyncIndexes();
    });
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS djs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    url TEXT,
    country TEXT,
    socialMediaUrls TEXT,
    musicStyles TEXT,
    lastUpdated DATE,
    profileUpdatedAt TEXT,
    emailsUpdatedAt TEXT,
    magicSyncedAt TEXT,
    profileErrorAt TEXT,
    profileErrorMessage TEXT,
    profileRetryAfter TEXT,
    profileFailureCount INTEGER NOT NULL DEFAULT 0,
    emails TEXT,
    emailSources TEXT,
    UNIQUE(name, url)
  )`, (err) => {
    if (err) {
      console.error('Error creating table:', err.message);
    }
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_djs_name ON djs(name)", (err) => {
    if (err) {
      console.error('Error creating djs name index:', err.message);
    }
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_djs_url ON djs(url)", (err) => {
    if (err) {
      console.error('Error creating djs url index:', err.message);
    }
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_djs_emails_present ON djs(emails) WHERE emails IS NOT NULL AND emails <> '' AND emails <> '[]'", (err) => {
    if (err) {
      console.error('Error creating djs emails index:', err.message);
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
      if (!columns.includes('emailSources')) {
        db.run("ALTER TABLE djs ADD COLUMN emailSources TEXT", (err) => {
          if (err) {
            console.error('Error adding column emailSources:', err.message);
          }
        });
      }
      if (!columns.includes('profileUpdatedAt')) {
        db.run("ALTER TABLE djs ADD COLUMN profileUpdatedAt TEXT", (err) => {
          if (err) {
            console.error('Error adding column profileUpdatedAt:', err.message);
          }
        });
      }
      if (!columns.includes('emailsUpdatedAt')) {
        db.run("ALTER TABLE djs ADD COLUMN emailsUpdatedAt TEXT", (err) => {
          if (err) {
            console.error('Error adding column emailsUpdatedAt:', err.message);
          }
        });
      }
      if (!columns.includes('magicSyncedAt')) {
        db.run("ALTER TABLE djs ADD COLUMN magicSyncedAt TEXT", (err) => {
          if (err) {
            console.error('Error adding column magicSyncedAt:', err.message);
          }
        });
      }
      if (!columns.includes('profileErrorAt')) {
        db.run("ALTER TABLE djs ADD COLUMN profileErrorAt TEXT", (err) => {
          if (err) {
            console.error('Error adding column profileErrorAt:', err.message);
          }
        });
      }
      if (!columns.includes('profileErrorMessage')) {
        db.run("ALTER TABLE djs ADD COLUMN profileErrorMessage TEXT", (err) => {
          if (err) {
            console.error('Error adding column profileErrorMessage:', err.message);
          }
        });
      }
      if (!columns.includes('profileRetryAfter')) {
        db.run("ALTER TABLE djs ADD COLUMN profileRetryAfter TEXT", (err) => {
          if (err) {
            console.error('Error adding column profileRetryAfter:', err.message);
          }
        });
      }
      if (!columns.includes('profileFailureCount')) {
        db.run("ALTER TABLE djs ADD COLUMN profileFailureCount INTEGER NOT NULL DEFAULT 0", (err) => {
          if (err) {
            console.error('Error adding column profileFailureCount:', err.message);
          }
        });
      }
    }
  });

  db.run(createMagicEmailerSyncTableSql(), (err) => {
    if (err) {
      console.error('Error creating magic_emailer_sync table:', err.message);
    }
  });

  ensureMagicEmailerSyncSchema();

  db.run(`CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'success', 'failed', 'stopped')),
    duration_ms INTEGER,
    start_letter TEXT,
    djs_found INTEGER NOT NULL DEFAULT 0,
    new_djs INTEGER NOT NULL DEFAULT 0,
    profiles_updated INTEGER NOT NULL DEFAULT 0,
    emails_found INTEGER NOT NULL DEFAULT 0,
    emails_queued_for_magic INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`, (err) => {
    if (err) {
      console.error('Error creating pipeline_runs table:', err.message);
    }
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status_finished ON pipeline_runs(status, finished_at)", (err) => {
    if (err) {
      console.error('Error creating pipeline_runs status index:', err.message);
    }
  });
});

function mapPipelineRun(row) {
  if (!row) return null;

  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    durationMs: row.duration_ms,
    startLetter: row.start_letter,
    djsFound: row.djs_found,
    newDjs: row.new_djs,
    profilesUpdated: row.profiles_updated,
    emailsFound: row.emails_found,
    emailsQueuedForMagic: row.emails_queued_for_magic,
    errorSummary: row.error_summary
  };
}

async function createPipelineRun(startLetter) {
  const startedAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO pipeline_runs (
       started_at,
       status,
       start_letter,
       created_at,
       updated_at
     )
     VALUES (?, 'running', ?, datetime('now'), datetime('now'))`,
    [startedAt, startLetter || null]
  );

  return {
    id: result.lastID,
    startedAt
  };
}

async function updatePipelineRun(id, updates = {}) {
  if (!id) return null;

  const fields = {
    finishedAt: 'finished_at',
    status: 'status',
    durationMs: 'duration_ms',
    startLetter: 'start_letter',
    djsFound: 'djs_found',
    newDjs: 'new_djs',
    profilesUpdated: 'profiles_updated',
    emailsFound: 'emails_found',
    emailsQueuedForMagic: 'emails_queued_for_magic',
    errorSummary: 'error_summary'
  };

  const assignments = [];
  const params = [];

  Object.entries(fields).forEach(([key, column]) => {
    if (updates[key] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(updates[key]);
    }
  });

  if (assignments.length === 0) return null;

  assignments.push("updated_at = datetime('now')");
  params.push(id);

  await run(
    `UPDATE pipeline_runs
     SET ${assignments.join(', ')}
     WHERE id = ?`,
    params
  );

  return getPipelineRun(id);
}

async function getPipelineRun(id) {
  const row = await get("SELECT * FROM pipeline_runs WHERE id = ?", [id]);
  return mapPipelineRun(row);
}

async function getLastSuccessfulPipelineRun() {
  const row = await get(
    `SELECT *
     FROM pipeline_runs
     WHERE status = 'success'
     ORDER BY finished_at DESC, id DESC
     LIMIT 1`
  );
  return mapPipelineRun(row);
}

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

function updateDJ(id, country, socialMediaUrls, musicStyles, emails, emailSources) {
  const profileWasUpdated = [country, socialMediaUrls, musicStyles]
    .some(value => value !== undefined && value !== null);
  const emailsWereUpdated = [emails, emailSources]
    .some(value => value !== undefined && value !== null);

  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE djs
       SET
        country = COALESCE(?, country),
        socialMediaUrls = COALESCE(?, socialMediaUrls),
        musicStyles = COALESCE(?, musicStyles),
        emails = COALESCE(?, emails),
        emailSources = COALESCE(?, emailSources),
        profileUpdatedAt = CASE WHEN ? THEN datetime('now') ELSE profileUpdatedAt END,
        profileErrorAt = CASE WHEN ? THEN NULL ELSE profileErrorAt END,
        profileErrorMessage = CASE WHEN ? THEN NULL ELSE profileErrorMessage END,
        profileRetryAfter = CASE WHEN ? THEN NULL ELSE profileRetryAfter END,
        profileFailureCount = CASE WHEN ? THEN 0 ELSE profileFailureCount END,
        emailsUpdatedAt = CASE WHEN ? THEN datetime('now') ELSE emailsUpdatedAt END,
        lastUpdated = CASE WHEN ? OR ? THEN DATE('now') ELSE lastUpdated END
       WHERE id = ?`,
      [
        country,
        socialMediaUrls,
        musicStyles,
        emails,
        emailSources,
        profileWasUpdated ? 1 : 0,
        profileWasUpdated ? 1 : 0,
        profileWasUpdated ? 1 : 0,
        profileWasUpdated ? 1 : 0,
        profileWasUpdated ? 1 : 0,
        emailsWereUpdated ? 1 : 0,
        profileWasUpdated ? 1 : 0,
        emailsWereUpdated ? 1 : 0,
        id
      ],
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

async function recordDJProfileFailure(id, errorMessage) {
  const existing = await get(
    "SELECT profileFailureCount FROM djs WHERE id = ?",
    [id]
  );
  const nextFailureCount = (Number(existing?.profileFailureCount) || 0) + 1;
  const retryHours = Math.min(168, Math.pow(2, Math.min(nextFailureCount, 6)));
  const retryAfter = new Date(Date.now() + retryHours * 60 * 60 * 1000).toISOString();

  await run(
    `UPDATE djs
     SET profileErrorAt = datetime('now'),
         profileErrorMessage = ?,
         profileRetryAfter = ?,
         profileFailureCount = ?
     WHERE id = ?`,
    [
      String(errorMessage || '').slice(0, 1000),
      retryAfter,
      nextFailureCount,
      id
    ]
  );

  return {
    profileFailureCount: nextFailureCount,
    profileRetryAfter: retryAfter
  };
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
      `SELECT *
       FROM djs
       WHERE (
           COALESCE(profileUpdatedAt, lastUpdated) IS NULL
           OR COALESCE(profileUpdatedAt, lastUpdated) < datetime('now', '-28 days')
         )
         AND (
           profileRetryAfter IS NULL
           OR profileRetryAfter <= datetime('now')
         )`,
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

function getDJsForEmailSearch() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT *
       FROM djs
       WHERE socialMediaUrls IS NOT NULL
         AND socialMediaUrls <> ''
         AND socialMediaUrls <> '[]'
         AND (
           emails IS NULL
           OR emails = ''
           OR emails = '[]'
           OR emailsUpdatedAt IS NULL
           OR emailsUpdatedAt < datetime('now', '-90 days')
         )`,
      [],
      (err, rows) => {
        if (err) {
          console.error(`Error retrieving DJs for email search: ${err.message}`);
          reject(err);
        } else {
          resolve(rows);
        }
      }
    );
  });
}

function mergeDiscoveryPayload(existingPayload, email, discovery) {
  const payload = existingPayload && typeof existingPayload === 'object' && !Array.isArray(existingPayload)
    ? existingPayload
    : {};

  const discoveries = Array.isArray(payload.discoveries)
    ? payload.discoveries
    : [];

  const nextDiscoveries = [...discoveries];
  const existingIndex = nextDiscoveries.findIndex(item =>
    Number(item.djId) === Number(discovery.djId) ||
    (item.djUrl && discovery.djUrl && item.djUrl === discovery.djUrl)
  );

  if (existingIndex >= 0) {
    const current = nextDiscoveries[existingIndex];
    nextDiscoveries[existingIndex] = {
      ...current,
      ...discovery,
      foundOnUrls: cleanStringArray([
        ...(Array.isArray(current.foundOnUrls) ? current.foundOnUrls : []),
        ...(Array.isArray(discovery.foundOnUrls) ? discovery.foundOnUrls : [])
      ]),
      socialMediaUrls: cleanStringArray([
        ...(Array.isArray(current.socialMediaUrls) ? current.socialMediaUrls : []),
        ...(Array.isArray(discovery.socialMediaUrls) ? discovery.socialMediaUrls : [])
      ]),
      country: cleanStringArray([
        ...(Array.isArray(current.country) ? current.country : []),
        ...(Array.isArray(discovery.country) ? discovery.country : [])
      ]),
      musicStyles: cleanStringArray([
        ...(Array.isArray(current.musicStyles) ? current.musicStyles : []),
        ...(Array.isArray(discovery.musicStyles) ? discovery.musicStyles : [])
      ])
    };
  } else {
    nextDiscoveries.push(discovery);
  }

  return {
    email,
    source: 'dj_discovery',
    flags: {
      ...(payload.flags && typeof payload.flags === 'object' ? payload.flags : {}),
      roleEmail: isRoleEmail(email)
    },
    discoveries: nextDiscoveries
  };
}

function buildMagicSyncDiscovery(dj, email) {
  const emailSources = parseJsonValue(dj.emailSources, {});
  const country = parseJsonValue(dj.country, []);
  const musicStyles = parseJsonValue(dj.musicStyles, []);
  const socialMediaUrls = parseJsonValue(dj.socialMediaUrls, []);

  return {
    djId: dj.id,
    djName: normalizeContactName(dj.name),
    djUrl: normalizeUrl(dj.url),
    foundOnUrls: cleanUrlArray(emailSources[email] || []),
    country: cleanStringArray(country),
    musicStyles: cleanStringArray(musicStyles),
    socialMediaUrls: cleanUrlArray(socialMediaUrls)
  };
}

async function queueMagicEmailerSyncContacts() {
  const rows = await all(`
    SELECT *
    FROM djs
    WHERE emails IS NOT NULL
      AND emails <> ''
      AND emails <> '[]'
  `);

  const summary = {
    scannedDjs: rows.length,
    discoveries: 0,
    queued: 0,
    updated: 0,
    skippedSynced: 0,
    skippedAlreadyExists: 0,
    retryDelayed: 0,
    roleEmails: 0,
    invalidEmails: 0
  };

  for (const dj of rows) {
    const emails = parseJsonValue(dj.emails, []);
    const rawEmails = Array.isArray(emails) ? emails : [];
    const cleanedEmailValues = rawEmails.map(cleanEmail);
    const cleanEmails = Array.from(new Set(
      cleanedEmailValues.filter(Boolean)
    ));

    summary.invalidEmails += cleanedEmailValues.filter(email => !email).length;

    for (const email of cleanEmails) {
      summary.discoveries++;
      if (isRoleEmail(email)) {
        summary.roleEmails++;
      }
      const existing = await get(
        "SELECT email, status, payload, retry_after FROM magic_emailer_sync WHERE email = ?",
        [email]
      );

      if (existing?.status === 'synced') {
        summary.skippedSynced++;
        continue;
      }

      if (existing?.status === 'skipped_already_exists') {
        summary.skippedAlreadyExists++;
        continue;
      }

      if (existing?.retry_after && new Date(existing.retry_after).getTime() > Date.now()) {
        summary.retryDelayed++;
        continue;
      }

      const existingPayload = parseJsonValue(existing?.payload, {});
      const payload = mergeDiscoveryPayload(
        existingPayload,
        email,
        buildMagicSyncDiscovery(dj, email)
      );

      if (existing) {
        await run(
          `UPDATE magic_emailer_sync
           SET payload = ?,
               status = CASE WHEN status = 'skipped' THEN status ELSE 'pending' END,
               retry_after = NULL,
               updated_at = datetime('now')
           WHERE email = ?`,
          [JSON.stringify(payload), email]
        );
        summary.updated++;
      } else {
        await run(
          `INSERT INTO magic_emailer_sync (
             email,
             status,
             payload,
             attempts,
             retry_after,
             created_at,
             updated_at
           )
           VALUES (?, 'pending', ?, 0, NULL, datetime('now'), datetime('now'))`,
          [email, JSON.stringify(payload)]
        );
        summary.queued++;
      }
    }
  }

  return summary;
}

function getMagicEmailerSyncStats() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT status, COUNT(*) AS count
       FROM magic_emailer_sync
       GROUP BY status`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.reduce((stats, row) => {
            stats[row.status] = row.count;
            return stats;
          }, { pending: 0, synced: 0, failed: 0, skipped: 0, skipped_already_exists: 0 }));
        }
      }
    );
  });
}

module.exports = {
  insertDJ,
  checkDJExists,
  updateDJ,
  recordDJProfileFailure,
  getAllDJs,
  getDJsToUpdate,
  getDJsForEmailSearch,
  getUniqueCountries,
  getUniqueStyles,
  getDJCount,
  getSearchableDJCount,
  getDJStats,
  getDJsWithEmailsCount,
  queueMagicEmailerSyncContacts,
  getMagicEmailerSyncStats,
  createPipelineRun,
  updatePipelineRun,
  getPipelineRun,
  getLastSuccessfulPipelineRun
};
