/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Using esm.sh for imports as required by AI Studio Build
import { GoogleGenAI, FunctionDeclaration, Content, Tool, Type, HarmCategory, HarmBlockThreshold, GenerateContentResponse } from '@google/genai';
import { html, render } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Prism from 'prismjs';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-c.js';


// --- Type Definitions ---
interface ApiEntry {
  name: string;
  type: string;
  comment: string;
  source_file: string;
  params: { name: string; type: string; description: string; default?: string }[];
  return_type?: string;
  full_declaration: string;
  tags: { return?: string; note?: string[]; error?: string[] };
  // For methodmaps
  methods?: any[];
  properties?: any[];
}

interface Message {
  role: 'user' | 'model';
  text: string;
}

interface AppState {
  messages: Message[];
  loading: boolean;
  apiData: ApiEntry[];
  systemInstruction?: Content;
  currentTool: string | null;
  showSettings: boolean;
  model: string;
  temperature: number;
  topP: number;
}

// --- Application State ---
const state: AppState = {
  messages: [],
  loading: false,
  apiData: [],
  systemInstruction: undefined,
  currentTool: null,
  showSettings: false,
  model: 'gemini-2.5-flash',
  temperature: 0.7,
  topP: 0.9,
};

// --- Conversation Persistence ---
const CONVERSATION_KEY = 'sourcemod-chat-history';
const SETTINGS_KEY = 'sourcemod-chat-settings';
const MESSAGE_HISTORY_LIMIT = 50;

function saveSettings() {
  try {
    const settings = {
      model: state.model,
      temperature: state.temperature,
      topP: state.topP,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const settings = JSON.parse(saved);
      state.model = settings.model || 'gemini-2.5-flash';
      state.temperature = settings.temperature ?? 0.7;
      state.topP = settings.topP ?? 0.9;
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
    localStorage.removeItem(SETTINGS_KEY);
  }
}

function saveConversation() {
  try {
    const history = state.messages.slice(-MESSAGE_HISTORY_LIMIT);
    localStorage.setItem(CONVERSATION_KEY, JSON.stringify(history));
  } catch (e) {
    console.error("Failed to save conversation:", e);
  }
}

function loadConversation(): Message[] | null {
  try {
    const saved = localStorage.getItem(CONVERSATION_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load conversation:", e);
    localStorage.removeItem(CONVERSATION_KEY);
  }
  return null;
}

function clearConversation() {
  localStorage.removeItem(CONVERSATION_KEY);
  state.messages = [{ role: 'model', text: "Hello! I'm your SourceMod AI Assistant, powered by Gemini. I have access to the SourceMod API documentation. How can I help you write a plugin today?" }];
  updateUI();
}

// --- API Key and Model Initialization ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.warn("API_KEY environment variable not set. This is expected in AI Studio Build.");
}
const genAI = new GoogleGenAI({apiKey: API_KEY});


// --- Tool Strategy ---
const searchApi: FunctionDeclaration = {
  name: 'search_api',
  description: 'Searches the SourceMod API for a keyword. Returns a list of matching function summaries. Use for broad queries.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The keyword or concept to search for (e.g., "player health", "create entity").',
      },
      api_type: {
        type: Type.STRING,
        description: 'Optional. Filter by type: "native", "stock", "forward", "methodmap", "typedef".',
      },
    },
    required: ['query'],
  },
};

const getApiDetails: FunctionDeclaration = {
  name: 'get_api_details',
  description: 'Retrieves full documentation for a SINGLE, EXACT function name. Use this after `search_api`.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "The exact, case-sensitive name of the function, native, or methodmap, such as 'GetClientName' or 'CreateTimer'.",
      },
    },
    required: ['name'],
  },
};

const tools: Tool[] = [{ functionDeclarations: [searchApi, getApiDetails] }];

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// --- API Caching ---
const CACHE_LIMIT = 100;
const apiSearchCache = new Map<string, any>();
const apiDetailsCache = new Map<string, any>();

// --- Tool Implementation ---
function executeSearchSourceModApi({ query, api_type }: { query: string; api_type?: string }) {
  const cacheKey = `${query}|${api_type || ''}`;
  if (apiSearchCache.has(cacheKey)) {
    console.log(`Cache hit for search: "${query}"`);
    return apiSearchCache.get(cacheKey);
  }

  console.log(`Searching API for query: "${query}", type: "${api_type || 'any'}"`);
  const lowerQuery = query.toLowerCase();
  
  let results = state.apiData;
  if (api_type) {
    results = results.filter(entry => entry.type.toLowerCase() === api_type.toLowerCase());
  }

  const scoredResults = results.map(entry => {
    let score = 0;
    const lowerName = entry.name.toLowerCase();
    if (lowerName === lowerQuery) score += 100;
    else if (lowerName.includes(lowerQuery)) score += 50;
    if (entry.comment.toLowerCase().includes(lowerQuery)) score += 20;
    if (entry.params) {
      entry.params.forEach(p => {
        if (p.description && p.description.toLowerCase().includes(lowerQuery)) score += 5;
      });
    }
    return { ...entry, score };
  }).filter(entry => entry.score > 0);

  scoredResults.sort((a, b) => b.score - a.score);
  
  const topResults = scoredResults.slice(0, 15).map(entry => ({
      name: entry.name,
      type: entry.type,
      summary: entry.comment.split('\n')[0],
      source_file: entry.source_file,
  }));
  const result = { results: topResults };

  if (apiSearchCache.size >= CACHE_LIMIT) {
    const firstKey = apiSearchCache.keys().next().value;
    apiSearchCache.delete(firstKey);
  }
  apiSearchCache.set(cacheKey, result);
  return result;
}

function executeGetApiDetails({ name }: { name: string }) {
    if (apiDetailsCache.has(name)) {
      console.log(`Cache hit for details: "${name}"`);
      return apiDetailsCache.get(name);
    }
    console.log(`Getting details for: "${name}"`);
    const result = state.apiData.find(entry => entry.name === name);
    let response;
    if (result) {
        response = { result };
    } else {
        response = { error: `Function or methodmap named '${name}' not found. Try searching for it first with search_api.` };
    }
    if (apiDetailsCache.size >= CACHE_LIMIT) {
      const firstKey = apiDetailsCache.keys().next().value;
      apiDetailsCache.delete(firstKey);
    }
    apiDetailsCache.set(name, response);
    return response;
}

const functionHandlers = {
    'search_api': executeSearchSourceModApi,
    'get_api_details': executeGetApiDetails,
};

// --- Main Application Logic ---
async function handlePrompt(prompt: string) {
  if (state.loading) return;

  const userMessage: Message = { role: 'user', text: prompt };
  state.messages.push(userMessage);
  state.loading = true;
  state.currentTool = null;
  updateUI();

  try {
    const contents: Content[] = state.messages.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    }));

    while (true) {
      const response: GenerateContentResponse = await genAI.models.generateContent({
        model: state.model,
        contents: contents,
        config: {
          tools,
          safetySettings,
          systemInstruction: state.systemInstruction,
          temperature: state.temperature,
          topP: state.topP,
        },
      });

      if (!response.candidates?.[0]?.content?.parts?.length) {
        const responseText = response.text;
        state.messages.push({ role: 'model', text: responseText || "I couldn't generate a response. It might be due to safety settings." });
        break;
      }

      const content = response.candidates[0].content;
      const functionCallParts = content.parts.filter(p => p.functionCall);

      if (functionCallParts.length > 0) {
        contents.push(content);
        
        const functionResponseParts = [];
        const toolNames = functionCallParts.map(p => p.functionCall.name).join(', ');
        state.currentTool = `Calling ${toolNames}...`;
        updateUI();

        for (const part of functionCallParts) {
            const { name, args } = part.functionCall;
            let handler = functionHandlers[name];
            
            // Handle potential model typo
            if (!handler && name === 'get_a_details') {
              handler = functionHandlers['get_api_details'];
            }

            if (!handler) {
                throw new Error(`Unknown function ${name}`);
            }
            const result = handler(args);
            functionResponseParts.push({
                functionResponse: {
                    name,
                    response: result,
                },
            });
        }

        contents.push({
          role: 'function',
          parts: functionResponseParts,
        });
      } else {
        const responseText = response.text;
        state.messages.push({ role: 'model', text: responseText || "I couldn't find an answer. Please try rephrasing your question." });
        break;
      }
    }
  } catch (e) {
    console.error(e);
    state.messages.push({ role: 'model', text: `An error occurred: ${e.message}. If the problem persists, please try again.` });
  } finally {
    state.loading = false;
    state.currentTool = null;
    saveConversation();
    updateUI();
  }
}

// --- UI Rendering ---

// --- Form Input Handlers ---
const handleInput = (e: InputEvent) => {
  const textarea = e.target as HTMLTextAreaElement;
  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, 300);
  textarea.style.height = `${newHeight}px`;
};

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const form = (e.target as HTMLTextAreaElement).closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }
};

const closeSettings = () => {
  loadSettings(); // Revert any unsaved changes
  state.showSettings = false;
  updateUI();
};

const saveAndCloseSettings = () => {
  saveSettings();
  state.showSettings = false;
  updateUI();
};

const App = () => {
  const userAvatar = html`<svg class="avatar" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`;
  const modelAvatar = html`<img class="avatar" src="https://avatars.githubusercontent.com/u/163359?s=200&v=4" alt="SourceMod Logo">`;

  return html`
    <header>
      <h1><img src="https://avatars.githubusercontent.com/u/163359?s=200&v=4" alt="SourceMod Logo"> SourceMod AI Assistant</h1>
      <p>Powered by Gemini</p>
      <button id="settings-btn" @click=${() => { state.showSettings = true; updateUI(); }} title="Settings">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>
      </button>
      <button id="clear-history-btn" @click=${clearConversation}>Clear History</button>
    </header>
    <div id="chat-container">
      ${state.messages.map(msg => html`
        <div class="message-wrapper ${msg.role}">
          ${msg.role === 'user' ? userAvatar : modelAvatar}
          <div class="message ${msg.role}">
            ${unsafeHTML(DOMPurify.sanitize(marked.parse(msg.text) as string))}
          </div>
        </div>
      `)}
      ${state.loading ? html`
        <div class="message-wrapper model">
          ${modelAvatar}
          <div class="message model loading">
            <span></span><span></span><span></span>
            ${state.currentTool ? html`<span class="loading-details">${state.currentTool}</span>` : ''}
          </div>
        </div>
      ` : ''}
    </div>
    <form id="prompt-form" @submit=${(e: SubmitEvent) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const instructionTextarea = form.querySelector('#prompt-input') as HTMLTextAreaElement;
      const codeTextarea = form.querySelector('#code-input') as HTMLTextAreaElement;
      
      const instruction = instructionTextarea.value.trim();
      const code = codeTextarea.value.trim();

      if (instruction || code) {
        let prompt = instruction;
        if (code) {
          if (prompt) {
            prompt += '\n\n';
          }
          prompt += '```sourcepawn\n' + code + '\n```';
        }
        handlePrompt(prompt);
        instructionTextarea.value = '';
        instructionTextarea.style.height = 'auto';
        codeTextarea.value = '';
        codeTextarea.style.height = 'auto';
      }
    }}>
      <div id="input-container">
        <div id="textarea-wrapper">
          <textarea
            id="code-input"
            placeholder="Paste SourcePawn code to analyze or modify..."
            .disabled=${state.loading}
            @input=${handleInput}
            @keydown=${handleKeydown}
            rows="1"
            aria-label="SourcePawn code input"
          ></textarea>
          <textarea
            id="prompt-input"
            placeholder="Ask a question or give instructions... (Shift+Enter for new line)"
            .disabled=${state.loading}
            @input=${handleInput}
            @keydown=${handleKeydown}
            rows="1"
            aria-label="Chat input"
          ></textarea>
        </div>
        <button type="submit" .disabled=${state.loading} title="Send" aria-label="Send message">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </form>

    ${state.showSettings ? html`
      <div id="settings-panel-overlay" @click=${closeSettings}>
        <div id="settings-panel" @click=${(e: Event) => e.stopPropagation()}>
          <h2>Model Configuration</h2>
          
          <div class="setting">
            <label for="model-select">Model</label>
            <select id="model-select" .value=${state.model} @change=${(e: Event) => state.model = (e.target as HTMLSelectElement).value}>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
            </select>
          </div>

          <div class="setting">
            <label for="temperature-slider">Temperature: <span id="temperature-value">${state.temperature.toFixed(2)}</span></label>
            <input type="range" id="temperature-slider" min="0" max="1" step="0.05" .value=${String(state.temperature)} @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              state.temperature = parseFloat(target.value);
              const valueEl = document.getElementById('temperature-value');
              if (valueEl) valueEl.textContent = state.temperature.toFixed(2);
            }}>
          </div>

          <div class="setting">
            <label for="topp-slider">Top-P: <span id="topp-value">${state.topP.toFixed(2)}</span></label>
            <input type="range" id="topp-slider" min="0" max="1" step="0.05" .value=${String(state.topP)} @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              state.topP = parseFloat(target.value);
              const valueEl = document.getElementById('topp-value');
              if (valueEl) valueEl.textContent = state.topP.toFixed(2);
            }}>
          </div>
          
          <button id="save-settings-btn" @click=${saveAndCloseSettings}>Save and Close</button>
        </div>
      </div>
    ` : ''}
  `;
};

function enhanceCodeBlocks() {
  document.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-block-header')) return;

    const code = pre.querySelector('code');
    if (!code) return;

    const language = Array.from(code.classList).find(cls => cls.startsWith('language-'))?.replace('language-', '') || '';
    
    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langName = document.createElement('span');
    langName.className = 'lang-name';
    langName.textContent = language === 'sourcepawn' ? 'SourcePawn' : language;
    header.appendChild(langName);

    const copyButton = document.createElement('button');
    copyButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy`;
    copyButton.onclick = () => {
      navigator.clipboard.writeText(code.textContent || '').then(() => {
        copyButton.textContent = 'Copied!';
        setTimeout(() => {
           copyButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy`;
        }, 2000);
      });
    };
    header.appendChild(copyButton);

    if (language === 'sourcepawn') {
      const downloadButton = document.createElement('button');
      downloadButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download`;
      downloadButton.onclick = () => {
        const blob = new Blob([code.textContent || ''], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'plugin.sp';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      header.appendChild(downloadButton);
    }

    pre.prepend(header);
    
    const prismLanguage = language === 'sourcepawn' ? 'c' : language;
    if (Prism.languages[prismLanguage]) {
        code.classList.remove(`language-${language}`);
        code.classList.add(`language-${prismLanguage}`);
        Prism.highlightElement(code);
    }
  });
}

function updateUI() {
  const root = document.getElementById('root');
  if (root) {
    render(App(), root);
    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    requestAnimationFrame(enhanceCodeBlocks);
  }
}

// --- Initialization ---
async function main() {
  loadSettings();
  updateUI();
  try {
    const [apiResponse, systemPromptResponse] = await Promise.all([
      fetch('sourcemod_api.json'),
      fetch('system_prompt.json')
    ]);

    if (!apiResponse.ok) {
        throw new Error(`Failed to load sourcemod_api.json: ${apiResponse.statusText}`);
    }
    if (!systemPromptResponse.ok) {
        throw new Error(`Failed to load system_prompt.json: ${systemPromptResponse.statusText}`);
    }

    const [apiData, systemPromptData] = await Promise.all([
      apiResponse.json(),
      systemPromptResponse.json()
    ]);
    
    state.apiData = apiData;
    state.systemInstruction = systemPromptData.systemInstruction;
    
    const savedMessages = loadConversation();
    if (savedMessages && savedMessages.length > 0) {
        state.messages = savedMessages;
    } else {
        state.messages.push({ role: 'model', text: "Hello! I'm your SourceMod AI Assistant, powered by Gemini. I have access to the SourceMod API documentation. How can I help you write a plugin today?" });
    }
  } catch (error) {
    console.error('Error loading initial data:', error);
    state.messages.push({ role: 'model', text: "I'm sorry, I couldn't load the necessary data. Please check the console for errors and ensure `sourcemod_api.json` and `system_prompt.json` are available." });
  } finally {
    updateUI();
  }
}

main();