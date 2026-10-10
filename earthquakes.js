/**
 * Endpoint HTTP yang dipanggil frontend (polling tiap 8 detik).
 * Data & logika gabung sumber ada di ./_shared/fetchQuakes.js, dan hasilnya
 * di-cache in-memory 6 detik supaya banyak client berbagi 1 fetch upstream.
 */
const { getQuakesCached } = require("./_shared/fetchQuakes");

exports.handler = async () => {
  const data = await getQuakesCached();
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data),
  };
};
