// Endpoint mappings for each provider
const API_ENDPOINTS = {
    openai: 'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models'
};

// Default models for each provider
const DEFAULT_MODELS = {
    openai: 'gpt-4',
    anthropic: 'claude-3-sonnet-20240229',
    gemini: 'gemini-2.0-flash'
};

// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['llmSettings'], (data) => {
        const settings = data.llmSettings || {};
        
        document.getElementById('useLLM').checked = settings.enabled || false;
        document.getElementById('apiProvider').value = settings.provider || 'openai';
        document.getElementById('apiKey').value = settings.apiKey || '';
        document.getElementById('model').value = settings.model || '';
        
        updateLLMSettingsVisibility();
    });
});

// Show/hide LLM settings based on checkbox
document.getElementById('useLLM').addEventListener('change', updateLLMSettingsVisibility);

function updateLLMSettingsVisibility() {
    const useLLM = document.getElementById('useLLM').checked;
    const llmSettings = document.getElementById('llmSettings');
    llmSettings.style.display = useLLM ? 'block' : 'none';
    
    // Set default model based on provider
    if (useLLM) {
        const provider = document.getElementById('apiProvider').value;
        updateDefaultModel(provider);
    }
}

// Update default model when provider changes
document.getElementById('apiProvider').addEventListener('change', (e) => {
    updateDefaultModel(e.target.value);
});

function updateDefaultModel(provider) {
    const modelInput = document.getElementById('model');
    const currentValue = modelInput.value;
    const isDefaultModel = currentValue === DEFAULT_MODELS.openai || 
                          currentValue === DEFAULT_MODELS.anthropic || 
                          currentValue === DEFAULT_MODELS.gemini;
    
    if (!currentValue || isDefaultModel) {
        modelInput.value = DEFAULT_MODELS[provider] || '';
    }
}

// Save settings
document.getElementById('saveBtn').addEventListener('click', async () => {
    const saveBtn = document.getElementById('saveBtn');
    const originalText = saveBtn.textContent;
    
    const provider = document.getElementById('apiProvider').value;
    const settings = {
        enabled: document.getElementById('useLLM').checked,
        provider: provider,
        endpoint: API_ENDPOINTS[provider], // Automatically set based on provider
        apiKey: document.getElementById('apiKey').value.trim(),
        model: document.getElementById('model').value.trim()
    };
    
    // Validate if LLM is enabled
    if (settings.enabled) {
        if (!settings.apiKey) {
            showStatus('Please enter an API key', 'error');
            return;
        }
        if (!settings.model) {
            showStatus('Please enter a model name', 'error');
            return;
        }
        
        // Validate API key
        saveBtn.disabled = true;
        saveBtn.textContent = 'Validating API key...';
        
        try {
            const isValid = await validateAPIKey(settings);
            if (!isValid) {
                showStatus('API key validation failed. Please check your API key and try again.', 'error');
                saveBtn.disabled = false;
                saveBtn.textContent = originalText;
                return;
            }
        } catch (error) {
            showStatus('Error validating API key: ' + error.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
            return;
        }
    }
    
    chrome.storage.local.set({ llmSettings: settings }, () => {
        showStatus('Settings saved successfully!', 'success');
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    });
});

// Function to validate API key by making a test request
async function validateAPIKey(settings) {
    try {
        if (settings.provider === 'openai') {
            const response = await fetch('https://api.openai.com/v1/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`
                }
            });
            return response.ok;
        } else if (settings.provider === 'anthropic') {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': settings.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: settings.model,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'test' }]
                })
            });
            // 400 is OK (means auth worked, just bad request), 401/403 means invalid key
            return response.status !== 401 && response.status !== 403;
        } else if (settings.provider === 'gemini') {
            const model = settings.model || 'gemini-2.0-flash';
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-goog-api-key': settings.apiKey
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: 'test' }]
                    }],
                    generationConfig: {
                        maxOutputTokens: 10
                    }
                })
            });
            // 400 is OK (means auth worked, just bad request), 401/403 means invalid key
            return response.status !== 401 && response.status !== 403;
        }
        return false;
    } catch (error) {
        throw new Error('Failed to validate API key: ' + error.message);
    }
}

function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = 'block';
    
    setTimeout(() => {
        status.style.display = 'none';
    }, 3000);
}

