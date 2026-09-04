// One-time import of Anthony's existing paper/notes client-session tracker
// into the database, using the legend he gave:
//   🟢 = one session paid in advance (credit)      🔴 = one unpaid session
//   ⚡️ = EMS session                                🦵 = Presso Therapy session
//   😊 = kids training session                     -$X = unpaid balance of $X
//   -$X(N) = N unpaid sessions at $X each          $X = amount paid in advance
// Run with: npm run seed  (safe to re-run against an EMPTY database only —
// it will not duplicate clients if they already exist by name).

const { db, init } = require('./client');

const DEFAULT_SERVICES = [
  { name: 'Personal Training', category: 'fitness', default_price: null },
  { name: 'Muay Thai', category: 'fitness', default_price: null },
  { name: 'Boxing', category: 'fitness', default_price: null },
  { name: 'Physical Therapy', category: 'therapy', default_price: null },
  { name: 'EMS', category: 'therapy', default_price: null },
  { name: 'Madero Therapy', category: 'therapy', default_price: null },
  { name: 'Presso Therapy', category: 'therapy', default_price: null },
  { name: 'Massage', category: 'recovery', default_price: null },
  { name: 'Fat Freezing', category: 'aesthetics', default_price: null },
  { name: 'Cavitation', category: 'aesthetics', default_price: null },
  { name: 'Recovery Session', category: 'recovery', default_price: null },
  { name: 'Kids Training', category: 'fitness', default_price: null },
];

// [section, name, rawMarks]
const LEGACY_ROWS = [
  ['done', 'Bebe Sucre', ''],
  ['done', 'Ines el hage', ''],
  ['done', 'Goodwill', '-100$'],
  ['done', 'C', '🟢🟢'],
  ['done', 'Andrew and marc raghad', '🔴🔴🔴🔴'],
  ['done', 'Peter bk', ''],
  ['done', 'Maria ghali', '5$'],
  ['done', 'Araji', '-70$ -70$'],
  ['done', 'Leo', ''],
  ['done', 'Elie saliba', '-25$'],
  ['done', 'Nanou', '-20$'],
  ['done', 'Aline souedan', '🟢'],
  ['done', 'Lina zakka', '🔴🔴'],
  ['done', 'Samir hanna', '🟢'],
  ['done', 'Chris iskandarian', 'note:renewal each 18th'],
  ['done', 'Yvonne tamer', '-30$(1)'],
  ['done', 'Lynn ghazarian', '-30$(9)'],
  ['done', 'Anthony bejjani', ''],
  ['credit', 'Jeanpaul Hajj', '$60'],
  ['credit', 'Cesar hajj', '$60'],
  ['credit', 'Paul mattar', ''],
  ['credit', 'Lamita eid', '🟢🟢🟢🟢 🦵🦵 😊'],
  ['credit', 'Sanaah ibrahim', '25$'],
  ['credit', 'Sandra khalil', ''],
  ['credit', 'Toufic el hakim', '🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢'],
  ['credit', 'Pascale saleh', '🟢🟢🟢🟢🟢🟢🟢🟢'],
  ['credit', 'Elie khoury pascal', '🟢🟢🟢'],
  ['credit', 'Tiana chahine', '🟢🟢🟢'],
  ['credit', 'Caroline hatiye', '⚡️⚡️'],
  ['credit', 'Dany hanboury', '🟢'],
  ['credit', 'Jad ghazal', ''],
  ['credit', 'Abdallah hindi', '🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢'],
  ['credit', 'Elio massoud', '🟢🟢'],
  ['credit', 'Leah khoury', '⚡️⚡️⚡️⚡️⚡️⚡️'],
  ['credit', 'Aline yacoubian', '🟢🟢🟢🟢🟢'],
  ['credit', 'Carole dib', '🟢'],
  ['credit', 'Eliane', '🟢'],
  ['credit', 'Jaquline mahfouz', '🟢🟢🟢'],
  ['credit', 'Maral', ''],
  ['credit', 'Maha Nasrallah', '🟢🟢🟢'],
  ['credit', 'Cynthia zgheib', '⚡️⚡️'],
  ['credit', 'Sandra harb', '🟢🟢 ⚡️⚡️'],
  ['credit', 'Sanah Dahdah', '🔴'],
  ['credit', 'Chris merheb', '🟢🟢'],
  ['credit', 'Andrew maalouf', '🔴 note:gatorade / 4 gummy packs'],
  ['credit', 'Anthony maatouk', '-15$'],
  ['credit', 'Dane gharib', '🟢🟢🟢🟢🟢🟢'],
  ['unpaid', 'Kimo', '🔴🔴🔴🔴🔴'],
];

const SECTION_LABEL = {
  done: 'Legacy import — "Sessions Done" list',
  credit: 'Legacy import — "Sessions In Account" (prepaid credit) list',
  unpaid: 'Legacy import — "Sessions Not Paid" list',
};

function parseMarks(raw) {
  const entries = [];
  let text = raw || '';

  // pull out an explicit free-text note: "note:...”
  let note = null;
  const noteMatch = text.match(/note:(.+)$/);
  if (noteMatch) {
    note = noteMatch[1].trim();
    text = text.slice(0, noteMatch.index);
  }

  // -$X(N)  ->  N unpaid entries of $X each
  text = text.replace(/-\$?(\d+(?:\.\d+)?)\$?\((\d+)\)/g, (_, amt, n) => {
    for (let i = 0; i < Number(n); i++) {
      entries.push({ payment_state: 'unpaid', amount: Number(amt), tag: null, note: `legacy unpaid balance (${n}x $${amt})` });
    }
    return '';
  });

  // -$X or -X$  -> one unpaid balance entry of $X
  text = text.replace(/-\$?(\d+(?:\.\d+)?)\$?/g, (_, amt) => {
    entries.push({ payment_state: 'unpaid', amount: Number(amt), tag: null, note: 'legacy unpaid balance' });
    return '';
  });

  // $X or X$ (no leading -) -> one prepaid amount entry
  text = text.replace(/\$(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\$/g, (_, a, b) => {
    const amt = a || b;
    entries.push({ payment_state: 'prepaid', amount: Number(amt), tag: null, note: 'legacy prepaid amount' });
    return '';
  });

  // emoji counts
  const emojiTag = [
    [/🟢/g, 'prepaid', null],
    [/🔴/g, 'unpaid', null],
    [/⚡️|⚡/g, 'prepaid', 'ems'],
    [/🦵/g, 'prepaid', 'presso'],
    [/😊/g, 'prepaid', 'kids'],
  ];
  for (const [re, state, tag] of emojiTag) {
    const matches = text.match(re);
    if (matches) {
      for (let i = 0; i < matches.length; i++) {
        entries.push({ payment_state: state, amount: null, tag, note: tag ? `legacy ${tag} session` : 'legacy session' });
      }
    }
  }

  return { entries, note };
}

async function seed() {
  await init();

  const existing = await db.execute('SELECT COUNT(*) as n FROM clients');
  if (Number(existing.rows[0].n) > 0) {
    console.log('Clients table is not empty — skipping seed to avoid duplicates.');
    return;
  }

  const serviceIds = {};
  for (const svc of DEFAULT_SERVICES) {
    const res = await db.execute({
      sql: 'INSERT INTO services (name, category, default_price) VALUES (?, ?, ?)',
      args: [svc.name, svc.category, svc.default_price],
    });
    serviceIds[svc.name] = Number(res.lastInsertRowid);
  }

  let clientCount = 0;
  let entryCount = 0;

  for (const [section, name, rawMarks] of LEGACY_ROWS) {
    const { entries, note } = parseMarks(rawMarks);
    const clientNote = [SECTION_LABEL[section], rawMarks ? `Raw: ${rawMarks}` : null, note]
      .filter(Boolean)
      .join(' | ');

    const res = await db.execute({
      sql: 'INSERT INTO clients (name, notes) VALUES (?, ?)',
      args: [name.trim(), clientNote],
    });
    const clientId = Number(res.lastInsertRowid);
    clientCount++;

    for (const e of entries) {
      await db.execute({
        sql: `INSERT INTO session_entries (client_id, service_id, payment_state, amount, tag, note, source)
              VALUES (?, NULL, ?, ?, ?, ?, 'legacy_import')`,
        args: [clientId, e.payment_state, e.amount, e.tag, e.note],
      });
      entryCount++;
    }
  }

  console.log(`Seeded ${clientCount} clients and ${entryCount} session entries from the legacy tracker.`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
