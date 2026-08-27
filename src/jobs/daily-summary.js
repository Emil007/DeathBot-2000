const cron = require("node-cron");
const { announceDailySummary } = require("../discord/announce");

function startDailySummary(client, config) {
  const hour = Math.min(23, Math.max(0, config.dailySummaryHour));
  const expr = `0 ${hour} * * *`;
  console.log(`[daily] scheduled at hour ${hour} (cron: ${expr})`);
  cron.schedule(expr, () => {
    announceDailySummary(client, config).catch((e) =>
      console.error("[daily] failed", e.message)
    );
  });
}

module.exports = { startDailySummary };
