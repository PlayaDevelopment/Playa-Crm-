/**
 * Seed / re-import entrypoint.
 * Loads real Stuart–Boca outreach from data/Playa_CRM.xlsx (via import-real).
 * Prefer: npm run import:real
 */
const { importReal, runCli } = require('./import-real');

function seed({ run, get }) {
  const result = importReal({ run, get });
  console.log(
    `Seeded ${result.accounts} accounts, ${result.touches} touches, ${result.deals} deals from real outreach data`
  );
  return result;
}

if (require.main === module) {
  runCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { seed };
