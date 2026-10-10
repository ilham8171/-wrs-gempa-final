const { getQuakesCached } = require("./_shared/fetchQuakes");

exports.handler = async () => {
  try {
    const data = await getQuakesCached();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("earthquakes endpoint failed", error);
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Data gempa sementara tidak tersedia" })
    };
  }
};
