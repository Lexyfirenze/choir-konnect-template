export default async function handler(req, res) {
  try {
    const response = await fetch(
      `${process.env.VITE_SUPABASE_URL}/rest/v1/library_pieces?select=id&limit=1`,
      {
        headers: {
          apikey: process.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Supabase ping failed: ${response.status}`);
    }

    res.status(200).json({ ok: true, pinged_at: new Date().toISOString() });
  } catch (err) {
    console.error('Keep-alive ping failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
