const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default async () => {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Response(JSON.stringify({ ok: false, error: "Missing Supabase configuration" }), { status: 503, headers });
  try {
    const response = await fetch(`${url}/rest/v1/players?select=id&limit=1`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`Supabase responded with ${response.status}`);
    return new Response(JSON.stringify({ ok: true, service: "kingsmen-badminton", checkedAt: new Date().toISOString() }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 503, headers });
  }
};
