import * as pdfjsLib from './build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  chrome.runtime.getURL('build/pdf.worker.mjs');


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

// Default desirability scoring settings
const DEFAULT_DESIRABILITY_CATEGORIES = [
    { name: 'Role category', matched_columns: ['title'], placeholder: 'e.g., Data Scientist, AI Engineer, Machine Learning', default_priority: 'high' },
    { name: 'Locations', matched_columns: ['locations'], placeholder: 'e.g., New York, NY; San Francisco, CA', default_priority: 'medium' },
    { name: 'Job type', matched_columns: ['jobType'], placeholder: 'e.g., internship, full-time, part-time', default_priority: 'mandatory' },
    { name: 'Work mode', matched_columns: ['workMode'], placeholder: 'e.g., remote, hybrid, flexible', default_priority: 'low' },
    { name: 'Experience level', matched_columns: ['experienceLevel'], placeholder: 'e.g., fresh grad, 1-3y, 3-5y', default_priority: 'high' },
    { name: 'Duration/Start time', matched_columns: ['duration'], placeholder: 'e.g., Immediate, 2025 summer', default_priority: 'high' },
    { name: 'Salary and Benefits', matched_columns: ['salaryAndBenefits'], placeholder: 'e.g., >$100k, 401k matching', default_priority: 'exclude' },
    { name: 'Visa sponsorship', matched_columns: ['visaSponsorship'], placeholder: 'e.g., visa sponsorship, H1B', default_priority: 'mandatory' },
    { name: 'Responsibility', matched_columns: ['responsibilities'], placeholder: 'feature engineering, statistical modeling', default_priority: 'medium' },
    { name: 'Skills', matched_columns: ['requiredSkills', 'preferredSkills'], placeholder: 'e.g., Python, SQL, research background', default_priority: 'medium' }
];

// Default eligibility scoring settings
const DEFAULT_ELIGIBILITY_CATEGORIES = [
    { name: 'Experience Level', matched_columns: ['experienceLevel'], placeholder: 'e.g., fresh grad, 1-3y, 3-5y', default_weight: 20 },
    { name: 'Education Level', matched_columns: ['educationLevel'], placeholder: 'e.g., Bachelor\'s, Master\'s', default_weight: 20 },
    { name: 'Required Skills', matched_columns: ['requiredSkills'], placeholder: 'e.g., Python, SQL, research background', default_weight: 50 },
    { name: 'Preferred Skills', matched_columns: ['preferredSkills'], placeholder: 'e.g., PyTorch, AWS', default_weight: 10 }
];

// ---- Resume state (shared across file) ----
let storedResume = null;

chrome.storage.sync.get(['resumeMeta'], (data) => {
    storedResume = data.resumeMeta || null;
});


// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Scoring Logic UI
    initializeDesirabilityUI();
    initializeEligibilityUI();
    initializeOverallControls();

    // --- Resume upload elements ---
    const uploadBtn = document.getElementById('upload-resume-btn');
    const resumeInput = document.getElementById('resumeInput');
    const resumeStatus = document.getElementById('resumeStatus');

    if (uploadBtn && resumeInput) {
        uploadBtn.addEventListener('click', () => {
            resumeInput.click();
        });
    }

    if (resumeInput) {
        resumeInput.addEventListener('change', async () => {
            const file = resumeInput.files[0];
            if (!file) return;

            const rawResumeText =
                file.type === 'application/pdf'
                    ? await extractTextFromPDF(file)
                    : await file.text();
          
            const resumeText = normalizeText(rawResumeText);
            const anonymizedResumeText = anonymizeResume(resumeText);
          
            const resumeMeta = {
                name: file.name,
                size: file.size,
                type: file.type,
                uploadedAt: new Date().toISOString()
            };

            chrome.storage.sync.set(
                {
                  resumeMeta,
                  resumeText,
                  anonymizedResumeText
                },
                () => {
                  storedResume = resumeMeta;
                  resumeStatus.textContent = `Uploaded: ${file.name}`;
                }
              );
        });
    }

    chrome.storage.sync.get(['resumeMeta'], (data) => {
        if (data.resumeMeta && resumeStatus) {
            resumeStatus.textContent = `Uploaded: ${data.resumeMeta.name}`;
        }
    });

    // Load all settings
    chrome.storage.sync.get(['llmSettings', 'downloadOption', 'scoringSettings'], (data) => {
        const settings = data.llmSettings || {};
        
        document.getElementById('useLLM').checked = settings.enabled || false;
        document.getElementById('apiProvider').value = settings.provider || 'openai';
        document.getElementById('apiKey').value = settings.apiKey || '';
        document.getElementById('model').value = settings.model || '';
        
        // Load download option
        const downloadSelect = document.getElementById('downloadOption');
        downloadSelect.value = data.downloadOption;

        // Load scoring settings
        const scoringSettings = data.scoringSettings || {};
        document.getElementById('useLLMScoring').checked = scoringSettings.enabled || false;

        updateLLMSettingsVisibility();
        updateLLMScoringVisibility();
    });

    // Add event listeners for reset buttons
    document.getElementById('reset-desirability').addEventListener('click', () => {
        const desirabilityRows = document.querySelectorAll('#desirability-grid .scoring-row');
        desirabilityRows.forEach(row => {
            // Clear preference input
            const preferenceInput = row.querySelector('input[type="text"]:not(.category-name-input)');
            if (preferenceInput) {
                preferenceInput.value = '';
                // Trigger input event to reset priority selector
                preferenceInput.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Clear custom category name input
            const categoryNameInput = row.querySelector('input.category-name-input');
            if (categoryNameInput) {
                categoryNameInput.value = '';
                categoryNameInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    });

    document.getElementById('reset-eligibility').addEventListener('click', () => {
        const eligibilityRows = document.querySelectorAll('#eligibility-grid .scoring-row');
        eligibilityRows.forEach((row, index) => {
            const weightInput = row.querySelector('input[type="number"]');
            weightInput.value = DEFAULT_ELIGIBILITY_CATEGORIES[index].default_weight;
        });
    });
});

// Show/hide LLM settings based on checkbox
document.getElementById('useLLM').addEventListener('change', updateLLMSettingsVisibility);
document.getElementById('useLLMScoring').addEventListener('change', updateLLMScoringVisibility);

function updateLLMSettingsVisibility() {
    const useLLM = document.getElementById('useLLM').checked;
    const llmSettings = document.getElementById('llmSettings');
    llmSettings.style.display = useLLM ? '' : 'none';
    
    // Set default model based on provider
    if (useLLM) {
        const provider = document.getElementById('apiProvider').value;
        updateDefaultModel(provider);
    }
}

function updateLLMScoringVisibility() {
    const useLLMScoring = document.getElementById('useLLMScoring').checked;
    const llmScoringSettings = document.getElementById('llmScoringSettings');
    llmScoringSettings.style.display = useLLMScoring ? 'block' : 'none';
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

    // Get download option
    const downloadOption = document.getElementById('downloadOption').value;
    
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
    
    // Collect scoring settings
    const desirabilityRows = document.querySelectorAll('#desirability-grid .scoring-row');
    const desirabilityCriteria = [];
    
    desirabilityRows.forEach(row => {
        let name = '';
        const labelDiv = row.querySelector('.category-label');
        if (labelDiv) {
            name = labelDiv.textContent;
        } else {
            const nameInput = row.querySelector('.category-name-input');
            if (nameInput) name = nameInput.value;
        }
        
        const preferenceInput = row.querySelector('input[type="text"]:not(.category-name-input)');
        const prioritySelector = row.querySelector('.priority-selector');
        
        if (name && preferenceInput && prioritySelector && preferenceInput.value.trim() !== '') {
             desirabilityCriteria.push({
                name: name,
                preference: preferenceInput.value,
                priority: prioritySelector.dataset.value
             });
        }
    });

    const scoringSettings = {
        enabled: document.getElementById('useLLMScoring').checked,
        desirabilityCriteria: desirabilityCriteria
    };

    // Validate Scoring Settings before saving
    const scoringValidation = validateScoringSettings();
    if (!scoringValidation.isValid) {
        showStatus(scoringValidation.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
        return;
    }
    

    // Save all settings
    chrome.storage.sync.set({ 
        llmSettings: settings,
        downloadOption: downloadOption,
        scoringSettings: scoringSettings
    }, () => {
        showStatus('Settings saved successfully!', 'success');
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    });
 });

function validateScoringSettings() {
    if (!document.getElementById('useLLMScoring').checked) {
        return { isValid: true };
    }

    const desirabilityWeight = parseInt(document.getElementById('desirability-weight-label').textContent, 10);
    const eligibilityWeight = 100 - desirabilityWeight;

    // Validate Desirability
    if (desirabilityWeight > 0) {
        let isDesirabilityConfigured = false;
        const desirabilityRows = document.querySelectorAll('#desirability-grid .scoring-row');
        desirabilityRows.forEach(row => {
            const preferenceInput = row.querySelectorAll('input[type="text"]')[row.querySelectorAll('input[type="text"]').length - 1];
            const prioritySelector = row.querySelector('.priority-selector');
            if (preferenceInput && preferenceInput.value.trim() !== '' && prioritySelector.dataset.value !== 'exclude') {
                isDesirabilityConfigured = true;
            }
        });
        if (!isDesirabilityConfigured) {
            return { isValid: false, message: 'Desirability weight is > 0%, but no criteria are set. Please add at least one preference or set the weight to 0%.' };
        }
    }

    // Validate Eligibility
    if (eligibilityWeight > 0) {
        let totalWeight = 0;
        const eligibilityInputs = document.querySelectorAll('#eligibility-grid .weight-input-container input');
        eligibilityInputs.forEach(input => {
            totalWeight += parseInt(input.value, 10) || 0;
        });

        if (totalWeight !== 100) {
            return { isValid: false, message: `Eligibility criteria weights must total 100%, but currently total ${totalWeight}%.` };
        }

        const hasResume = !!storedResume;; // Hardcoded as requested
        if (!hasResume) {
            return { isValid: false, message: 'Eligibility weight is > 0%, but no resume has been uploaded. Please upload files or set the weight to 0%.' };
        }
    }

    return { isValid: true };
}

// --- SCORING LOGIC UI ---

function initializeOverallControls() {
    // --- Weighting Slider ---
    const weightOverall = document.getElementById('weight-overall');
    const weightThumb = document.getElementById('weight-thumb');
    const desirabilityLabel = document.getElementById('desirability-weight-label');
    const eligibilityLabel = document.getElementById('eligibility-weight-label');

    // --- Threshold Slider ---
    const thresholdOverall = document.getElementById('threshold-overall');
    const thresholdThumb = document.getElementById('threshold-thumb');
    const thresholdLabel = document.getElementById('threshold-label');

    function setupOverallControl(overallContainer, thumb, onUpdate) {
        thumb.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const containerRect = overallContainer.getBoundingClientRect();

            function onMouseMove(moveEvent) {
                let newX = moveEvent.clientX - containerRect.left;
                let percent = (newX / containerRect.width) * 100;
                percent = Math.max(0, Math.min(100, percent)); // Clamp between 0 and 100
                
                thumb.style.left = `${percent}%`;
                onUpdate(Math.round(percent));
            }

            function onMouseUp() {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // Setup Weighting Slider
    setupOverallControl(weightOverall, weightThumb, (percent) => {
        desirabilityLabel.textContent = percent;
        eligibilityLabel.textContent = 100 - percent;
    });

    // Setup Threshold Slider
    setupOverallControl(thresholdOverall, thresholdThumb, (percent) => {
        thresholdLabel.textContent = percent;
    });

    // --- Set Default Values ---
    // For now, hardcode eligibility as valid and check desirability
    const isEligibilityValid = true; // Per instructions
    let isDesirabilityValid = false;
    const desirabilityInputs = document.querySelectorAll('#desirability-grid input[type="text"]');
    desirabilityInputs.forEach(input => {
        if (input.value.trim() !== '') {
            isDesirabilityValid = true;
        }
    });

    let defaultWeight = 70;

    // Set default for weight slider
    desirabilityLabel.textContent = defaultWeight;
    eligibilityLabel.textContent = 100 - defaultWeight;
    weightThumb.style.left = `${defaultWeight}%`;

    // Set default for threshold slider
    const defaultThreshold = 70;
    thresholdLabel.textContent = defaultThreshold;
    thresholdThumb.style.left = `${defaultThreshold}%`;
}


function initializeEligibilityUI() {
    const container = document.getElementById('eligibility-grid');

    DEFAULT_ELIGIBILITY_CATEGORIES.forEach(cat => {
        const row = createEligibilityRow(cat.name, cat.placeholder, cat.default_weight);
        container.appendChild(row);
    });

}

function createEligibilityRow(name, placeholder, defaultWeight) {
    const fragment = document.createDocumentFragment();
    const row = document.createElement('div');
    row.className = 'scoring-row';

    // Category Name
    const nameLabel = document.createElement('div');
    nameLabel.textContent = name;
    nameLabel.className = 'category-label';

    // Weight Input
    const weightContainer = document.createElement('div');
    weightContainer.className = 'weight-input-container';

    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.value = defaultWeight;
    weightInput.min = 0;
    weightInput.max = 100;

    if (name === 'Preferred Skills') {
        weightInput.id = 'preferred-skills-weight';
    }

    // Add validation on blur to ensure the value is within the 0-100 range
    weightInput.addEventListener('blur', () => {
        let value = parseInt(weightInput.value, 10);
        if (isNaN(value) || value < 0) {
            weightInput.value = 0;
        } else if (value > 100) {
            weightInput.value = 100;
        }
    });

    const percentSign = document.createElement('span');
    percentSign.textContent = '%';

    weightContainer.appendChild(weightInput);
    weightContainer.appendChild(percentSign);

    row.appendChild(nameLabel);
    row.appendChild(weightContainer);
    
    fragment.appendChild(row);
    return fragment;
}

function initializeDesirabilityUI() {
    const container = document.getElementById('desirability-grid');
    DEFAULT_DESIRABILITY_CATEGORIES.forEach(cat => {
        const row = createDesirabilityRow(cat.name, cat.placeholder, cat.default_priority, false);
        container.appendChild(row);
    });

    // Always show 3 custom category rows
    for (let i = 0; i < 3; i++) {
        const row = createDesirabilityRow('', 'Enter keywords for your category', 'medium', true);
        container.appendChild(row);
    }
}

function createDesirabilityRow(name, placeholder, defaultPriority, isCustom) {
    const fragment = document.createDocumentFragment();
    const row = document.createElement('div');
    row.className = 'scoring-row';

    // Category Name
    const nameLabel = document.createElement('div');
    if (isCustom) {
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = name;
        nameInput.placeholder = 'Custom Category';
        nameInput.className = 'category-name-input';
        nameLabel.appendChild(nameInput);
    } else {
        nameLabel.textContent = name;
        nameLabel.className = 'category-label';
    }

    // Preference Input
    const preferenceInput = document.createElement('input');
    preferenceInput.type = 'text';
    preferenceInput.placeholder = placeholder;

    // If it's a custom row, add logic to enable/disable the preference input
    if (isCustom) {
        const categoryNameInput = nameLabel.querySelector('.category-name-input');
        const updatePreferenceState = () => {
            if (categoryNameInput.value.trim() === '') {
                preferenceInput.disabled = true;
                preferenceInput.title = 'Please input category name first';
            } else {
                preferenceInput.disabled = false;
                preferenceInput.title = '';
            }
        };
        categoryNameInput.addEventListener('input', updatePreferenceState);
        updatePreferenceState(); // Set initial state
    }

    // Priority Selector (Horizontal Boxes)
    const priorityContainer = document.createElement('div');
    priorityContainer.className = 'priority-selector';
    priorityContainer.dataset.value = defaultPriority;

    const priorities = [
        { value: 'mandatory', text: 'Mandatory' },
        { value: 'high', text: 'High' },
        { value: 'medium', text: 'Medium' },
        { value: 'low', text: 'Low' },
        { value: 'exclude', text: 'Exclude' }
    ];

    priorities.forEach(p => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'priority-option';
        optionDiv.dataset.value = p.value;
        optionDiv.textContent = p.text;
        if (p.value === defaultPriority) {
            optionDiv.classList.add('selected');
        }
        optionDiv.addEventListener('click', () => {
            if (priorityContainer.classList.contains('disabled')) return;
            priorityContainer.dataset.value = p.value;
            priorityContainer.querySelectorAll('.priority-option').forEach(opt => {
                opt.classList.toggle('selected', opt.dataset.value === p.value);
            });
        });
        priorityContainer.appendChild(optionDiv);
    });

    // Event listener to toggle priority selector
    preferenceInput.addEventListener('input', () => {
        if (preferenceInput.value.trim() === '') {
            priorityContainer.classList.add('disabled');
            priorityContainer.dataset.value = 'exclude'; // Visually update
            priorityContainer.querySelectorAll('.priority-option').forEach(opt => opt.classList.remove('selected'));
            priorityContainer.querySelector('[data-value="exclude"]').classList.add('selected');
        } else {
            priorityContainer.classList.remove('disabled');
            // If it was excluded, set it back to default
            if (priorityContainer.dataset.value === 'exclude') {
                priorityContainer.dataset.value = defaultPriority;
                priorityContainer.querySelectorAll('.priority-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                priorityContainer.querySelector(`[data-value="${defaultPriority}"]`).classList.add('selected');
            }
        }
    });

    // Initial state
    if (preferenceInput.value.trim() === '') {
        priorityContainer.classList.add('disabled');
        priorityContainer.dataset.value = 'exclude';
        priorityContainer.querySelector(`[data-value="${defaultPriority}"]`)?.classList.remove('selected');
        priorityContainer.querySelector('[data-value="exclude"]').classList.add('selected');
    }

    row.appendChild(nameLabel);
    row.appendChild(preferenceInput);
    row.appendChild(priorityContainer);
    
    fragment.appendChild(row);
    return fragment;
}

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

// helper function to extract resume text
async function extractTextFromPDF(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(' ') + '\n';
      }
      return text;
    } catch (err) {
      console.error('PDF extraction failed:', err);
      return '';
    }
  }

// helper function to normlaize text for embedding similarity 
function normalizeText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\u0000/g, '')
      .trim();
  }
  

// helper function to anonymize resume
function anonymizeResume(text) {
    let anonymized = text;
  
    // 1. Email
    anonymized = anonymized.replace(
      /\b[\w.-]+@[\w.-]+\.\w+\b/g,
      '[EMAIL]'
    );
  
    // 2. Phone
    anonymized = anonymized.replace(
        /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
        '[PHONE]'
    );
  
    // 3. Name — ONLY at start or after "Resume"/"Name"
    anonymized = anonymized.replace(
      /^(Resume\s+Example\s+)?([A-Z][a-z]+ [A-Z][a-z]+)/m,
      '[NAME]'
    );
  
    anonymized = anonymized.replace(
      /(Name:\s*)([A-Z][a-z]+ [A-Z][a-z]+)/,
      '$1[NAME]'
    );
  
    return anonymized;
  }
  
  
  
function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = 'block';
    
    setTimeout(() => {
        status.style.display = 'none';
    }, 10000);
}
