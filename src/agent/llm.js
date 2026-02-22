const config = require('../config/config');

let openaiClient = null;
let openaiClientKey = null;

function getOpenAIApiKey() {
  return config.get('openaiApiKey') || process.env.OPENAI_API_KEY;
}

function getOpenAIClient() {
  const key = getOpenAIApiKey();
  // Recreate client if key changed
  if (openaiClient && openaiClientKey === key) return openaiClient;
  const OpenAI = require('openai');
  openaiClient = new OpenAI({ apiKey: key });
  openaiClientKey = key;
  return openaiClient;
}

async function callOpenAI(systemPrompt, messages, maxTokens = 300) {
  const client = getOpenAIClient();
  const model = config.get('openaiModel') || 'gpt-4o';

  const formatted = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  const inputChars = formatted.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const startTime = Date.now();
  console.log(`  \x1b[90m[LLM] OpenAI/${model} | ${inputChars} chars in | max ${maxTokens} tokens out...\x1b[0m`);

  const response = await client.chat.completions.create({
    model,
    messages: formatted,
    max_tokens: maxTokens,
    temperature: 0.5,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const output = response.choices[0].message.content;
  console.log(`  \x1b[90m[LLM] Done in ${elapsed}s | ${output?.length || 0} chars out\x1b[0m`);

  return output;
}

async function callOllama(systemPrompt, messages, maxTokens = 300) {
  const host = config.get('ollamaHost') || 'http://localhost:11434';
  const model = config.get('ollamaModel') || 'llama3';

  const formatted = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  // Calculate input size for logging
  const inputChars = formatted.reduce((sum, m) => sum + m.content.length, 0);
  const startTime = Date.now();
  console.log(`  \x1b[90m[LLM] Ollama/${model} | ${inputChars} chars in | max ${maxTokens} tokens out...\x1b[0m`);

  // Timeout: ~30s per 1000 tokens requested, minimum 60s
  const timeoutMs = Math.max(60000, maxTokens * 30);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: formatted,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0.5 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Ollama timed out after ${Math.round(timeoutMs / 1000)}s (model: ${model}, max_tokens: ${maxTokens})`);
    }
    throw new Error(`Ollama connection failed: ${err.message} — is Ollama running at ${host}?`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }

  const data = await response.json();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const content = data.message?.content || '';
  console.log(`  \x1b[90m[LLM] Done in ${elapsed}s | ${content.length} chars out\x1b[0m`);

  if (!content) {
    throw new Error(`Ollama returned empty response (model: ${model})`);
  }

  return content;
}

async function callLLM(systemPrompt, messages, maxTokens = 300) {
  const provider = config.get('llmProvider') || 'openai';

  if (provider === 'ollama') {
    return callOllama(systemPrompt, messages, maxTokens);
  }

  // Default to OpenAI
  if (!getOpenAIApiKey()) {
    console.log('No OPENAI_API_KEY set, falling back to Ollama...');
    return callOllama(systemPrompt, messages, maxTokens);
  }

  return callOpenAI(systemPrompt, messages, maxTokens);
}

/**
 * Call OpenAI with vision support (image_url content blocks).
 * @param {string} systemPrompt
 * @param {Array} messages - [{role, content}] where content can be text or array with image_url blocks
 * @param {Array<string>} base64Images - Array of base64-encoded images (data URIs or raw base64)
 * @param {number} maxTokens
 */
async function callOpenAIWithVision(systemPrompt, messages, base64Images = [], maxTokens = 1000) {
  const client = getOpenAIClient();
  const model = config.get('openaiModel') || 'gpt-4o';

  // Build content array with images
  const userContent = [];

  // Add text from last user message
  const lastUser = messages.find(m => m.role === 'user');
  if (lastUser) {
    userContent.push({ type: 'text', text: lastUser.content });
  }

  // Add images
  for (const img of base64Images) {
    const dataUri = img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`;
    userContent.push({
      type: 'image_url',
      image_url: { url: dataUri, detail: 'low' },
    });
  }

  const formatted = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const response = await client.chat.completions.create({
    model,
    messages: formatted,
    max_tokens: maxTokens,
    temperature: 0.5,
  });

  return response.choices[0].message.content;
}

module.exports = { callLLM, callOpenAI, callOllama, callOpenAIWithVision };
