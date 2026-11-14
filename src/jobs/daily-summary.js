const cron = require("node-cron");
const { announceDailySummary } = require("../discord/announce");

function startDailySummary(client, config) {
  const hour = Math.min(23, Math.max(0, config.dailySummaryHour));
  const expr = `0 ${hour} * * *`;
  console.log(`[daily] scheduled at hour ${hour} (cron: ${expr})`);
  // Der Tagesbericht läuft um DAILY_SUMMARY_HOUR in config.tz. main() setzt außerdem process.env.TZ = config.tz, damit der Container nicht auf UTC stehen bleibt.
  cron.schedule(expr, () => {
    announceDailySummary(client, config).catch((e) =>
      console.error("[daily] failed", e.message)
    );
  }, { timezone: config.tz });
}

module.exports = { startDailySummary };
