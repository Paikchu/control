export const secAnalysisModel = process.env.DEEPSEEK_SEC_MODEL || 'deepseek-chat';
export const strategyModel = process.env.DEEPSEEK_STRATEGY_MODEL || 'deepseek-chat';
export const valuationModel = process.env.DEEPSEEK_VALUATION_MODEL || 'deepseek-chat';
export const managementModel = process.env.DEEPSEEK_MGMT_MODEL || 'deepseek-chat';

export function hasDeepSeekKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

// Thin wrapper over DeepSeek chat completions in JSON mode.
// Returns the raw message content string; callers parse and validate.
export async function deepseekChat({ model, temperature = 0.1, system, user }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set on the API server');

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || '';
}
