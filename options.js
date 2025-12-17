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
    openai: 'gpt-4o-mini',
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
    { name: 'Skills', matched_columns: 'requiredSkills', placeholder: 'e.g., Python, SQL, research background', default_priority: 'medium' }
];

// Default eligibility scoring settings
const DEFAULT_ELIGIBILITY_CATEGORIES = [
    { name: 'Experience Level', matched_columns: ['experienceLevel'], placeholder: 'e.g., fresh grad, 1-3y, 3-5y', default_weight: 30 }, 
    { name: 'Education Level', matched_columns: ['educationLevel'], placeholder: 'e.g., Bachelor\'s, Master\'s', default_weight: 20 },
    { name: 'Required Skills', matched_columns: ['requiredSkills'], placeholder: 'e.g., Python, SQL, research background', default_weight: 50 },
];

// ---- Resume state ----
let storedResume = null;

chrome.storage.sync.get(['resumeMeta'], ({ resumeMeta }) => {
    const hasResume = !!resumeMeta;
  });  

// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Scoring Logic UI
    initializeDesirabilityUI();
    initializeEligibilityUI();
    initializeOverallControls();

    // Load all settings
    chrome.storage.sync.get(['llmScraperSettings', 'downloadOption', 'scoringSettings', 'llmScoringSettings'], (data) => {
        const scraperSettings = data.llmScraperSettings || {};
        const scoringAPISettings = data.llmScoringSettings || {};
        
        document.getElementById('useLLM').checked = scraperSettings.enabled || false;
        document.getElementById('apiProvider').value = scraperSettings.provider || 'openai';
        document.getElementById('apiKey').value = scraperSettings.apiKey || '';
        document.getElementById('model').value = scraperSettings.model || '';
        
        document.getElementById('useLLMScoring').checked = (data.scoringSettings && data.scoringSettings.enabled) || false;
        document.getElementById('apiProviderScoring').value = scoringAPISettings.provider || 'openai';
        document.getElementById('apiKeyScoring').value = scoringAPISettings.apiKey || '';
        document.getElementById('modelScoring').value = scoringAPISettings.model || '';
        
        // Load download option
        const downloadSelect = document.getElementById('downloadOption');
        downloadSelect.value = data.downloadOption || 'manual';

        // Load scoring settings
        const scoringSettings = data.scoringSettings || {};
        document.getElementById('useLLMScoring').checked = scoringSettings.enabled || false;

        updateLLMSettingsVisibility();
        updateLLMScoringVisibility();

        // Load desirability and eligibility details after UI is initialized
        loadEligibilityDetails(scoringSettings.eligibilityCriteria || []);
        loadDesirabilityDetails(scoringSettings.desirabilityCriteria || []);
        
        // Load weights and threshold
        const desirabilityWeight = scoringSettings.desirabilityWeight !== undefined ? scoringSettings.desirabilityWeight : 70;
        const eligibilityWeight = scoringSettings.eligibilityWeight !== undefined ? scoringSettings.eligibilityWeight : 30;
        const threshold = scoringSettings.threshold !== undefined ? scoringSettings.threshold : 70;
        
        document.getElementById('desirability-weight-label').textContent = desirabilityWeight;
        document.getElementById('eligibility-weight-label').textContent = eligibilityWeight;
        document.getElementById('threshold-label').textContent = threshold;
        document.getElementById('weight-thumb').style.left = `${desirabilityWeight}%`;
        document.getElementById('threshold-thumb').style.left = `${threshold}%`;
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
            const detailsInput = row.querySelector('.details-input');
            const weightInput = row.querySelector('.weight-input-container input');
            if (detailsInput) detailsInput.value = '';
            if (weightInput) weightInput.value = DEFAULT_ELIGIBILITY_CATEGORIES[index].default_weight;
        });
    });

    // Resume upload handler (merged)
    document.getElementById('resume-upload').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        try {
            let rawText = '';

            // ---- Extract text ----
            if (file.type === 'text/plain') {
                rawText = await readFileAsText(file);
            } else if (file.type === 'application/pdf') {
                rawText = await extractTextFromPDF(file);
            } else {
                alert('Please upload a TXT or PDF file.');
                return;
            }

            // parsing 
            const resumeText = normalizeText(rawText);
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
                }
            );

            parseResumeAndFillDetails(resumeText);

            showStatus(`Resume uploaded: ${file.name}`, 'success');

        } catch (error) {
            console.error('Error reading file:', error);
            alert('Error reading file: ' + error.message);
        }
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
    const llmScoringAPISettings = document.getElementById('llmScoringAPISettings');
    llmScoringSettings.style.display = useLLMScoring ? 'block' : 'none';
    llmScoringAPISettings.style.display = useLLMScoring ? 'block' : 'none';
}

// Update default model when provider changes
document.getElementById('apiProvider').addEventListener('change', (e) => {
    updateDefaultModel(e.target.value, 'model');
});
document.getElementById('apiProviderScoring').addEventListener('change', (e) => {
    updateDefaultModel(e.target.value, 'modelScoring');
});

function updateDefaultModel(provider, modelId = 'model') {
    const modelInput = document.getElementById(modelId);
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
    
    const scraperProvider = document.getElementById('apiProvider').value;
    const scraperSettings = {
        enabled: document.getElementById('useLLM').checked,
        provider: scraperProvider,
        endpoint: API_ENDPOINTS[scraperProvider], // Automatically set based on provider
        apiKey: document.getElementById('apiKey').value.trim(),
        model: document.getElementById('model').value.trim()
    };

    const scoringProvider = document.getElementById('apiProviderScoring').value;
    const scoringAPISettings = {
        enabled: document.getElementById('useLLMScoring').checked,
        provider: scoringProvider,
        endpoint: API_ENDPOINTS[scoringProvider], // Automatically set based on provider
        apiKey: document.getElementById('apiKeyScoring').value.trim(),
        model: document.getElementById('modelScoring').value.trim()
    };

    // Get download option
    const downloadOption = document.getElementById('downloadOption').value;
    
    // Validate scraper LLM if enabled
    if (scraperSettings.enabled) {
        if (!scraperSettings.apiKey) {
            showStatus('Please enter an API key for scraper', 'error');
            return;
        }
        if (!scraperSettings.model) {
            showStatus('Please enter a model name for scraper', 'error');
            return;
        }
        
        // Validate API key
        saveBtn.disabled = true;
        saveBtn.textContent = 'Validating scraper API key...';
        
        try {
            const isValid = await validateAPIKey(scraperSettings);
            if (!isValid) {
                showStatus('Scraper API key validation failed. Please check your API key and try again.', 'error');
                saveBtn.disabled = false;
                saveBtn.textContent = originalText;
                return;
            }
        } catch (error) {
            showStatus('Error validating scraper API key: ' + error.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
            return;
        }
    }

    // Validate scoring LLM if enabled
    if (scoringAPISettings.enabled) {
        if (!scoringAPISettings.apiKey) {
            showStatus('Please enter an API key for scoring', 'error');
            return;
        }
        if (!scoringAPISettings.model) {
            showStatus('Please enter a model name for scoring', 'error');
            return;
        }
        
        // Validate API key
        saveBtn.disabled = true;
        saveBtn.textContent = 'Validating scoring API key...';
        
        try {
            const isValid = await validateAPIKey(scoringAPISettings);
            if (!isValid) {
                showStatus('Scoring API key validation failed. Please check your API key and try again.', 'error');
                saveBtn.disabled = false;
                saveBtn.textContent = originalText;
                return;
            }
        } catch (error) {
            showStatus('Error validating scoring API key: ' + error.message, 'error');
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

    // Collect eligibility criteria
    const eligibilityRows = document.querySelectorAll('#eligibility-grid .scoring-row');
    const eligibilityCriteria = [];
    
    eligibilityRows.forEach(row => {
        const name = row.querySelector('.category-label').textContent;
        const detailsInput = row.querySelector('.details-input');
        const weightInput = row.querySelector('.weight-input-container input');
        
        if (name && detailsInput && weightInput) {
            eligibilityCriteria.push({
                name: name,
                details: detailsInput.value.trim(),
                weight: parseInt(weightInput.value, 10) || 0
            });
        }
    });

    const scoringSettings = {
        enabled: document.getElementById('useLLMScoring').checked,
        desirabilityCriteria: desirabilityCriteria,
        eligibilityCriteria: eligibilityCriteria,
        desirabilityWeight: parseInt(document.getElementById('desirability-weight-label').textContent, 10),
        eligibilityWeight: parseInt(document.getElementById('eligibility-weight-label').textContent, 10),
        threshold: parseInt(document.getElementById('threshold-label').textContent, 10)
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
        llmScraperSettings: scraperSettings,
        downloadOption: downloadOption,
        scoringSettings: scoringSettings,
        llmScoringSettings: scoringAPISettings
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
        let hasDetails = false;
        const eligibilityRows = document.querySelectorAll('#eligibility-grid .scoring-row');
        eligibilityRows.forEach(row => {
            const weightInput = row.querySelector('.weight-input-container input');
            const detailsInput = row.querySelector('.details-input');
            totalWeight += parseInt(weightInput.value, 10) || 0;
            if (detailsInput && detailsInput.value.trim() !== '') {
                hasDetails = true;
            }
        });

        if (totalWeight !== 100) {
            return { isValid: false, message: `Eligibility criteria weights must total 100%, but currently total ${totalWeight}%.` };
        }

        const hasResume = !!storedResume;

        if (!hasDetails && !hasResume) {
            return {
                isValid: false,
                message: 'Eligibility weight is > 0%, but no resume or details have been provided.'
            };
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

    // Note: Default values are set in the loading code to ensure saved values take precedence
}


function initializeEligibilityUI() {
    const container = document.getElementById('eligibility-grid');

    DEFAULT_ELIGIBILITY_CATEGORIES.forEach(cat => {
        const row = createEligibilityRow(cat.name, cat.placeholder, cat.default_weight);
        container.appendChild(row);
    });

}

function loadEligibilityDetails(eligibilityCriteria) {
    const eligibilityRows = document.querySelectorAll('#eligibility-grid .scoring-row');
    eligibilityRows.forEach((row, index) => {
        if (eligibilityCriteria[index]) {
            const detailsInput = row.querySelector('.details-input');
            const weightInput = row.querySelector('.weight-input-container input');
            if (detailsInput) detailsInput.value = eligibilityCriteria[index].details || '';
            if (weightInput) weightInput.value = eligibilityCriteria[index].weight || DEFAULT_ELIGIBILITY_CATEGORIES[index].default_weight;
        }
    });
}

function loadDesirabilityDetails(desirabilityCriteria) {
    const desirabilityRows = document.querySelectorAll('#desirability-grid .scoring-row');
    
    desirabilityCriteria.forEach(criterion => {
        // Find existing row by name
        let targetRow = null;
        desirabilityRows.forEach(row => {
            const labelDiv = row.querySelector('.category-label');
            const nameInput = row.querySelector('.category-name-input');
            
            let rowName = '';
            if (labelDiv) {
                rowName = labelDiv.textContent;
            } else if (nameInput) {
                rowName = nameInput.value;
            }
            
            if (rowName === criterion.name) {
                targetRow = row;
            }
        });
        
        // If not found, find an empty custom row
        if (!targetRow) {
            desirabilityRows.forEach(row => {
                const nameInput = row.querySelector('.category-name-input');
                if (nameInput && nameInput.value.trim() === '') {
                    if (!targetRow) {
                        targetRow = row;
                        nameInput.value = criterion.name;
                        // Trigger input event to enable preference input
                        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            });
        }
        
        // If still not found, create a new custom row
        if (!targetRow) {
            const container = document.getElementById('desirability-grid');
            const newRow = createDesirabilityRow(criterion.name, 'Enter keywords for your category', criterion.priority, true);
            container.appendChild(newRow);
            targetRow = newRow;
        }
        
        // Set the preference and priority
        if (targetRow) {
            const preferenceInput = targetRow.querySelector('input[type="text"]:not(.category-name-input)');
            const prioritySelector = targetRow.querySelector('.priority-selector');
            
            if (preferenceInput) {
                preferenceInput.value = criterion.preference;
                // Trigger input event to update priority selector state
                preferenceInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            if (prioritySelector) {
                prioritySelector.dataset.value = criterion.priority;
                prioritySelector.querySelectorAll('.priority-option').forEach(opt => {
                    opt.classList.toggle('selected', opt.dataset.value === criterion.priority);
                });
            }
        }
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

    // Container for Details and Weight
    const detailsWeightContainer = document.createElement('div');
    detailsWeightContainer.style.display = 'flex';
    detailsWeightContainer.style.justifyContent = 'space-between';
    detailsWeightContainer.style.alignItems = 'center';
    detailsWeightContainer.style.gap = '10px';

    // Details Input
    const detailsInput = document.createElement('input');
    detailsInput.type = 'text';
    detailsInput.placeholder = placeholder;
    detailsInput.className = 'details-input';
    detailsInput.style.flexGrow = '1';

    // Weight Input
    const weightContainer = document.createElement('div');
    weightContainer.className = 'weight-input-container';

    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.value = defaultWeight;
    weightInput.min = 0;
    weightInput.max = 100;

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

    detailsWeightContainer.appendChild(detailsInput);
    detailsWeightContainer.appendChild(weightContainer);

    row.appendChild(nameLabel);
    row.appendChild(detailsWeightContainer);
    
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

function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = 'block';
    
    setTimeout(() => {
        status.style.display = 'none';
    }, 3000);
}

// Helper function to read file as text
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('File reading error'));
        reader.readAsText(file);
    });
}

// Placeholder function to parse resume and fill details
function parseResumeAndFillDetails(text) {
    // Simple parsing logic - this is a placeholder
    const lowerText = text.toLowerCase();
    
    // Experience Level
    let experience = '';
    if (lowerText.includes('senior') || lowerText.includes('lead') || lowerText.includes('manager')) {
        experience = 'Senior (5+ years)';
    } else if (lowerText.includes('mid') || lowerText.includes('intermediate')) {
        experience = 'Mid-level (3-5 years)';
    } else if (lowerText.includes('junior') || lowerText.includes('entry') || lowerText.includes('fresh')) {
        experience = 'Entry-level (0-2 years)';
    } else {
        experience = 'Mid-level (3-5 years)'; // default
    }
    
    // Education Level
    let education = '';
    if (lowerText.includes('phd') || lowerText.includes('doctorate')) {
        education = 'PhD';
    } else if (lowerText.includes('master') || lowerText.includes('ms') || lowerText.includes('ma')) {
        education = "Master's";
    } else if (lowerText.includes('bachelor') || lowerText.includes('bs') || lowerText.includes('ba')) {
        education = "Bachelor's";
    } else {
        education = "Bachelor's"; // default
    }
    
    // Required Skills - extract common skills
    const skills = [];
    const skillKeywords = ['python', 'javascript', 'java', 'sql', 'machine learning', 'data analysis', 'react', 'node.js', 'aws', 'docker'];
    skillKeywords.forEach(skill => {
        if (lowerText.includes(skill)) {
            skills.push(skill.charAt(0).toUpperCase() + skill.slice(1));
        }
    });
    const requiredSkills = skills.slice(0, 3).join(', '); // take first 3
    
    // Fill the inputs
    const eligibilityRows = document.querySelectorAll('#eligibility-grid .scoring-row');
    eligibilityRows.forEach((row, index) => {
        const detailsInput = row.querySelector('.details-input');
        if (detailsInput) {
            switch (index) {
                case 0: // Experience Level
                    detailsInput.value = experience;
                    break;
                case 1: // Education Level
                    detailsInput.value = education;
                    break;
                case 2: // Required Skills
                    detailsInput.value = requiredSkills;
                    break;
            }
        }
    });
    
    showStatus('Resume parsed and details filled!', 'success');
}

// ============================================
// SAVED JOBS MANAGEMENT
// ============================================

let savedJobs = [];
let currentJobIndex = -1;

// Initialize saved jobs UI
function initializeSavedJobsUI() {
    loadSavedJobs();
    
    // Event listeners
    document.getElementById('refresh-jobs').addEventListener('click', loadSavedJobs);
    document.getElementById('download-jobs').addEventListener('click', downloadJobsCSV);
    document.getElementById('clear-all-jobs').addEventListener('click', clearAllJobs);
    
    // Modal events
    document.querySelector('.modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('modal-delete-btn').addEventListener('click', deleteCurrentJob);
    
    // Close modal on outside click
    document.getElementById('job-modal').addEventListener('click', (e) => {
        if (e.target.id === 'job-modal') {
            closeModal();
        }
    });
    
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    });
}

// Load saved jobs from storage
function loadSavedJobs() {
    chrome.storage.local.get({ jobs: [] }, (data) => {
        savedJobs = data.jobs || [];
        renderJobsTable();
    });
}

// Render jobs table
function renderJobsTable() {
    const tbody = document.getElementById('jobs-tbody');
    const noJobsMessage = document.getElementById('no-jobs-message');
    const jobsCount = document.getElementById('jobs-count');
    
    // Update count
    jobsCount.textContent = `${savedJobs.length} job${savedJobs.length !== 1 ? 's' : ''} saved`;
    
    // Clear existing rows
    tbody.innerHTML = '';
    
    if (savedJobs.length === 0) {
        noJobsMessage.style.display = 'block';
        document.getElementById('jobs-table').style.display = 'none';
        return;
    }
    
    noJobsMessage.style.display = 'none';
    document.getElementById('jobs-table').style.display = 'table';
    
    savedJobs.forEach((item, index) => {
        const job = item.job || item;
        const row = document.createElement('tr');
        
        // Format date
        const scrapedDate = job.scrapedAt ? formatDate(job.scrapedAt) : 'N/A';
        
        // Truncate description
        const shortDesc = truncateText(job.description || '', 100);
        
        row.innerHTML = `
            <td>
                <span class="job-title" data-index="${index}">${escapeHtml(job.title || 'Untitled')}</span>
            </td>
            <td>${escapeHtml(job.company || 'N/A')}</td>
            <td>${escapeHtml(job.locations || 'N/A')}</td>
            <td><div class="job-description">${escapeHtml(shortDesc)}</div></td>
            <td class="job-date">${scrapedDate}</td>
            <td>
                <button class="btn-icon delete" data-index="${index}" title="Delete job">🗑️</button>
            </td>
        `;
        
        tbody.appendChild(row);
    });
    
    // Add click handlers for job titles
    tbody.querySelectorAll('.job-title').forEach(el => {
        el.addEventListener('click', () => {
            const index = parseInt(el.dataset.index);
            openJobModal(index);
        });
    });
    
    // Add click handlers for delete buttons
    tbody.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            deleteJob(index);
        });
    });
}

// Open job details modal
function openJobModal(index) {
    const item = savedJobs[index];
    const job = item.job || item;
    currentJobIndex = index;
    
    document.getElementById('modal-job-title').textContent = job.title || 'Untitled';
    document.getElementById('modal-job-company').textContent = job.company || 'N/A';
    document.getElementById('modal-job-location').textContent = job.locations || 'N/A';
    
    const urlEl = document.getElementById('modal-job-url');
    urlEl.href = job.url || '#';
    urlEl.textContent = job.url || 'N/A';
    
    document.getElementById('modal-job-scraped').textContent = job.scrapedAt ? 
        new Date(job.scrapedAt).toLocaleString() : 'N/A';
    
    document.getElementById('modal-job-description').textContent = job.description || 'No description available.';
    
    document.getElementById('job-modal').style.display = 'block';
}

// Close modal
function closeModal() {
    document.getElementById('job-modal').style.display = 'none';
    currentJobIndex = -1;
}

// Delete current job from modal
function deleteCurrentJob() {
    if (currentJobIndex >= 0) {
        deleteJob(currentJobIndex);
        closeModal();
    }
}

// Delete a job by index
function deleteJob(index) {
    if (index < 0 || index >= savedJobs.length) return;
    
    const job = savedJobs[index].job || savedJobs[index];
    const jobTitle = job.title || 'this job';
    
    if (!confirm(`Are you sure you want to delete "${jobTitle}"?`)) {
        return;
    }
    
    savedJobs.splice(index, 1);
    
    chrome.storage.local.set({ jobs: savedJobs }, () => {
        if (chrome.runtime.lastError) {
            showStatus('Error deleting job: ' + chrome.runtime.lastError.message, 'error');
        } else {
            showStatus('Job deleted successfully!', 'success');
            renderJobsTable();
            
            // Update badge
            chrome.runtime.sendMessage({ action: 'updateBadge', count: savedJobs.length });
        }
    });
}

// Clear all jobs
function clearAllJobs() {
    if (savedJobs.length === 0) {
        showStatus('No jobs to clear.', 'info');
        return;
    }
    
    if (!confirm(`Are you sure you want to delete all ${savedJobs.length} saved jobs? This cannot be undone.`)) {
        return;
    }
    
    chrome.storage.local.set({ jobs: [] }, () => {
        if (chrome.runtime.lastError) {
            showStatus('Error clearing jobs: ' + chrome.runtime.lastError.message, 'error');
        } else {
            savedJobs = [];
            renderJobsTable();
            showStatus('All jobs cleared successfully!', 'success');
            
            // Update badge
            chrome.runtime.sendMessage({ action: 'updateBadge', count: 0 });
        }
    });
}

// Download jobs as CSV
function downloadJobsCSV() {
    if (savedJobs.length === 0) {
        showStatus('No jobs to download.', 'info');
        return;
    }
    
    chrome.runtime.sendMessage({ action: 'downloadCSV' }, (response) => {
        if (response && response.success) {
            showStatus('CSV download started!', 'success');
        } else {
            showStatus('Error downloading CSV: ' + (response?.error || 'Unknown error'), 'error');
        }
    });
}

// Helper: Format date
function formatDate(dateStr) {
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric',
            year: '2-digit'
        });
    } catch (e) {
        return 'N/A';
    }
}

// Helper: Truncate text
function truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// Helper: Escape HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

    // 4. Address (very conservative)
    anonymized = anonymized.replace(
        /\b\d{1,5}\s+\w+(?:\s+\w+)*,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5}\b/g,
        '[ADDRESS]'
    );
  
    return anonymized;
  }
// Initialize on DOM load
document.addEventListener('DOMContentLoaded', initializeSavedJobsUI);
