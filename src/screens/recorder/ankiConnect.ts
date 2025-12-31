export async function ankiRequest(payload: unknown) {
  const urls = ["http://127.0.0.1:8765", "http://localhost:8765"];
  let lastError: unknown;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return json;
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(
    `AnkiConnectに接続できませんでした（既定: 127.0.0.1:8765）。Ankiを起動し、AnkiConnectアドオンが有効か確認してください。詳細: ${String(lastError)}`
  );
}
