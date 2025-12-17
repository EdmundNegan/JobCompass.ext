// Check if LLM is configured
document.addEventListener('DOMContentLoaded', async () => {
    // Retrieve settings from sync storage (matching options.js)
    const data = await chrome.storage.sync.get(['llmScraperSettings', 'scoringSettings', 'llmScoringSettings']);
    const llmScraperSettings = data.llmScraperSettings;
    const scoringSettings = data.scoringSettings;
    const llmScoringSettings = data.llmScoringSettings;
    
    const scrapeLLMBtn = document.getElementById('scrapeLLM');
    const scrapeAndScoreBtn = document.getElementById('scrapeAndScoreLLM');
    const scoreDesirabilityBtn = document.getElementById('scoreDesirability');
    
    // Check Scrape with LLM API button
    if (!llmScraperSettings || !llmScraperSettings.enabled || !llmScraperSettings.apiKey) {
        scrapeLLMBtn.disabled = true;
        scrapeLLMBtn.title = 'Please enable LLM for Scraping and configure API in Options first';
    }
    
    // Check Scrape & Score with LLM API button (requires both scraping and scoring enabled)
    if (!llmScraperSettings || !llmScraperSettings.enabled || !llmScraperSettings.apiKey ||
        !scoringSettings || !scoringSettings.enabled || !llmScoringSettings || !llmScoringSettings.apiKey ||
        !scoringSettings.desirabilityCriteria || scoringSettings.desirabilityCriteria.length === 0) {
        scrapeAndScoreBtn.disabled = true;
        if (!llmScraperSettings || !llmScraperSettings.enabled) {
            scrapeAndScoreBtn.title = 'Please enable LLM for Scraping in Options first';
        } else if (!scoringSettings || !scoringSettings.enabled) {
            scrapeAndScoreBtn.title = 'Please enable LLM for Scoring in Options first';
        } else if (!llmScraperSettings.apiKey) {
            scrapeAndScoreBtn.title = 'Please configure Scraping API key in Options first';
        } else if (!llmScoringSettings || !llmScoringSettings.apiKey) {
            scrapeAndScoreBtn.title = 'Please configure Scoring API key in Options first';
        } else {
            scrapeAndScoreBtn.title = 'Please configure Desirability Criteria in Options first';
        }
    }
    
    // Check Score for All Saved Jobs button
    if (!scoringSettings || !scoringSettings.enabled || !llmScoringSettings || !llmScoringSettings.apiKey ||
        !scoringSettings.desirabilityCriteria || scoringSettings.desirabilityCriteria.length === 0) {
        scoreDesirabilityBtn.disabled = true;
        if (!scoringSettings || !scoringSettings.enabled) {
            scoreDesirabilityBtn.title = 'Enable LLM Scoring in Options to use this feature';
        } else if (!llmScoringSettings || !llmScoringSettings.apiKey) {
            scoreDesirabilityBtn.title = 'Please configure Scoring API key in Options first';
        } else {
            scoreDesirabilityBtn.title = 'Please configure Desirability Criteria in Options first';
        }
    }
});

// Helper to manage button loading state
function setButtonLoading(btn, isLoading, loadingText) {
    const btnText = btn.querySelector('.btn-text');
    if (isLoading) {
        btn.classList.add('loading');
        btn.disabled = true;
        btnText.textContent = loadingText;
    } else {
        btn.classList.remove('loading');
        btn.disabled = false;
        btnText.textContent = btn.dataset.originalText;
    }
}

// Scrape with default method
document.getElementById('scrapeDefault').addEventListener('click', async () => {
    const btn = document.getElementById('scrapeDefault');
    btn.dataset.originalText = btn.querySelector('.btn-text').textContent;
    setButtonLoading(btn, true, 'Scraping...');
    
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab.id) {
            showStatus('Error: Could not access current tab', 'error');
            return;
        }
        
        // Send message to background script to scrape
        chrome.runtime.sendMessage({
            action: 'scrape',
            method: 'default',
            tabId: tab.id
        }, (response) => {
            setButtonLoading(btn, false);
            
            if (chrome.runtime.lastError) {
                showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
            }
            
            // Check for duplicate
            if (response && response.isDuplicate) {
                handleDuplicateJob(response, tab.id, false, null);
                return;
            }
            
            if (response && response.success) {
                // Check download option to show the correct message
                chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                    const message = options.downloadOption === 'any_scrape'
                        ? 'Job scraped and downloaded to your device!'
                        : 'Job scraped and saved to the backend!';
                    showStatus(message, 'success');
                });
            } else {
                showStatus(response?.error || 'Failed to scrape job', 'error');
            }
        });
    } catch (error) {
        setButtonLoading(btn, false);
        showStatus('Error: ' + error.message, 'error');
    }
});

// Scrape with LLM API
document.getElementById('scrapeLLM').addEventListener('click', async () => {
    const btn = document.getElementById('scrapeLLM');
    btn.dataset.originalText = btn.querySelector('.btn-text').textContent;
    setButtonLoading(btn, true, 'Scraping with LLM...');
    
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab.id) {
            showStatus('Error: Could not access current tab', 'error');
            return;
        }
        
        // Get LLM settings
        const settings = await chrome.storage.sync.get(['llmScraperSettings']);
        const llmSettings = settings.llmScraperSettings; // Ensure we get it from sync
        
        if (!llmSettings || !llmSettings.enabled || !llmSettings.apiKey) {
            showStatus('Please configure LLM API in Options first', 'error');
            setButtonLoading(btn, false);
            return;
        }
        
        // Send message to background script to scrape with LLM
        chrome.runtime.sendMessage({
            action: 'scrape',
            method: 'llm',
            tabId: tab.id,
            settings: llmSettings
        }, (response) => {
            setButtonLoading(btn, false);
            
            if (chrome.runtime.lastError) {
                showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
            }
            
            // Check for duplicate
            if (response && response.isDuplicate) {
                handleDuplicateJob(response, tab.id, false, llmSettings);
                return;
            }
            
            if (response && response.success) {
                // Check download option to show the correct message
                chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                    const message = options.downloadOption === 'any_scrape'
                        ? 'Job scraped with LLM and downloaded to your device!'
                        : 'Job scraped with LLM and saved to the backend!';
                    showStatus(message, 'success');
                });
            } else {
                const errorMsg = response?.error || 'Failed to scrape job with LLM';
                showStatus('LLM Scraping Failed: ' + errorMsg, 'error');
            }
        });
    } catch (error) {
        setButtonLoading(btn, false);
        showStatus('Error: ' + error.message, 'error');
    }
});

// Scrape and Score with LLM API
const scrapeAndScoreBtn = document.getElementById('scrapeAndScoreLLM');
if (scrapeAndScoreBtn) {
    scrapeAndScoreBtn.addEventListener('click', async () => {
        const btn = scrapeAndScoreBtn;
        btn.dataset.originalText = btn.querySelector('.btn-text')?.textContent || btn.textContent;
        setButtonLoading(btn, true, 'Scraping & Scoring...');
        
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (!tab.id) {
                showStatus('Error: Could not access current tab', 'error');
                return;
            }
            
            // Get LLM settings
            const settings = await chrome.storage.sync.get(['llmScraperSettings']);
            const llmSettings = settings.llmScraperSettings; // Ensure we get it from sync
            
            if (!llmSettings || !llmSettings.enabled || !llmSettings.apiKey) {
                showStatus('Please configure LLM API in Options first', 'error');
                setButtonLoading(btn, false);
                return;
            }
            
            // Send message to background script to scrape with LLM and force score
            chrome.runtime.sendMessage({
                action: 'scrape',
                method: 'llm',
                tabId: tab.id,
                settings: llmSettings,
                score: true // Force scoring
            }, (response) => {
                setButtonLoading(btn, false);
                
                if (chrome.runtime.lastError) {
                    showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                    return;
                }
                
                // Check for duplicate
                if (response && response.isDuplicate) {
                    handleDuplicateJob(response, tab.id, true, llmSettings);
                    return;
                }
                
                if (response && response.success) {
                    // Check download option to show the correct message
                    chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                        const opt = options.downloadOption;
                        const willDownload = ['any_scrape', 'any_score', 'scrape_and_score'].includes(opt);
                        const message = willDownload
                            ? 'Job scraped, scored, and downloaded to your device!'
                            : 'Job scraped, scored, and saved to the backend!';
                        showStatus(message, 'success');
                    });
                } else {
                    const errorMsg = response?.error || 'Failed to scrape/score job';
                    showStatus('Operation Failed: ' + errorMsg, 'error');
                }
            });
        } catch (error) {
            setButtonLoading(btn, false);
            showStatus('Error: ' + error.message, 'error');
        }
    });
}

// Score Desirability for all saved jobs (missing scores)
const scoreDesirabilityBtn = document.getElementById('scoreDesirability');
if (scoreDesirabilityBtn) {
    scoreDesirabilityBtn.addEventListener('click', async () => {
        const btn = scoreDesirabilityBtn;
        btn.dataset.originalText = btn.querySelector('.btn-text')?.textContent || btn.textContent;
        setButtonLoading(btn, true, 'Scoring...');
        
        chrome.runtime.sendMessage({ action: 'scoreSavedJobs' }, (response) => {
            setButtonLoading(btn, false);
            if (chrome.runtime.lastError) {
                showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
            } else if (response && response.success) {
                chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                    const message = options.downloadOption === 'any_score'
                        ? 'Jobs scored and downloaded to your device!'
                        : 'Jobs scored and saved to the backend!';
                    showStatus(message, 'success');
                });
            } else {
                showStatus(response?.error || 'Failed to score jobs', 'error');
            }
        });
    });
}

// Open options page
document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

// View/Edit saved jobs (opens options page to saved jobs section)
document.getElementById('viewEditJobs').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

// Download saved jobs (download CSV)
document.getElementById('downloadJobs').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ action: 'downloadCSV' }, (response) => {
        if (response && response.success) {
            showStatus('CSV downloaded!', 'success');
        } else {
            showStatus('No jobs to download', 'info');
        }
    });
});

// Clear all saved jobs
document.getElementById('clearJobs').addEventListener('click', async (e) => {
    e.preventDefault();
    if (confirm('Are you sure you want to clear all saved jobs? This action cannot be undone.')) {
        chrome.runtime.sendMessage({ action: 'clearJobs' }, (response) => {
            if (response && response.success) {
                showStatus('All jobs cleared!', 'success');
            } else {
                showStatus('Failed to clear jobs', 'error');
            }
        });
    }
});

// Handle duplicate job detection
function handleDuplicateJob(response, tabId, triggerScore, llmSettings) {
    const info = response.duplicateInfo;
    const scrapedAt = info.scrapedAt ? new Date(info.scrapedAt).toLocaleDateString() : 'unknown date';
    
    const message = `This job appears to be already saved:\n\n` +
        `"${info.title || 'Untitled'}"\n` +
        `at ${info.company || 'Unknown Company'}\n` +
        `(saved on ${scrapedAt})\n\n` +
        `Do you want to save it again anyway?`;
    
    if (confirm(message)) {
        // User confirmed - force save the job
        showStatus('Saving duplicate job...', 'info');
        
        chrome.runtime.sendMessage({
            action: 'forceSaveJob',
            job: response.scrapedJob,
            tabId: tabId,
            triggerScore: triggerScore,
            settings: llmSettings
        }, (saveResponse) => {
            if (saveResponse && saveResponse.success) {
                chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                    const message = options.downloadOption === 'any_scrape'
                        ? 'Job saved and downloaded!'
                        : 'Job saved to the backend!';
                    showStatus(message, 'success');
                });
            } else {
                showStatus('Failed to save job: ' + (saveResponse?.error || 'Unknown error'), 'error');
            }
        });
    } else {
        // User cancelled
        showStatus('Job not saved (duplicate skipped)', 'info');
    }
}

function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = 'block';
    
    if (type === 'success' || type === 'info') {
        setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
    }
}
