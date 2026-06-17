export function hasSearchKey() {
  return Boolean(process.env.TAVILY_API_KEY);
}

// Thin wrapper over Tavily search. Returns [{title, url, snippet}]; throws if no key or HTTP error.
export async function searchWeb(query, { maxResults = 5 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set on the API server');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic'
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily HTTP ${response.status}`);
  }

  const payload = await response.json();
  return (payload.results || []).map((result) => ({
    title: result.title || '',
    url: result.url || '',
    snippet: result.content || ''
  }));
}
