// Check if LLM is configured
document.addEventListener('DOMContentLoaded', async () => {
    // Retrieve settings from sync storage (matching options.js)
    const data = await chrome.storage.sync.get(['llmSettings', 'scoringSettings']);
    const llmSettings = data.llmSettings;
    const scoringSettings = data.scoringSettings;
    
    const scrapeLLMBtn = document.getElementById('scrapeLLM');
    const scrapeAndScoreBtn = document.getElementById('scrapeAndScoreLLM');
    const scoreDesirabilityBtn = document.getElementById('scoreDesirability');
    
    // 1. Check LLM API Configuration
    if (!llmSettings || !llmSettings.enabled || !llmSettings.apiKey) {
        const buttons = [scrapeLLMBtn, scrapeAndScoreBtn, scoreDesirabilityBtn];
        buttons.forEach(btn => {
            if (btn) {
                btn.disabled = true;
                btn.title = 'Please configure LLM API in Options first';
            }
        });
    } else {
        // 2. Check Scoring Configuration for Scoring Buttons
        if (!scoringSettings || !scoringSettings.enabled || !scoringSettings.desirabilityCriteria || scoringSettings.desirabilityCriteria.length === 0) {
            const scoringButtons = [scrapeAndScoreBtn, scoreDesirabilityBtn];
            scoringButtons.forEach(btn => {
                if (btn) {
                    btn.disabled = true;
                    if (!scoringSettings || !scoringSettings.enabled) {
                        btn.title = 'Enable LLM Scoring in Options to use this feature';
                    } else {
                        btn.title = 'Please configure Desirability Criteria in Options first';
                    }
                }
            });
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
            
            if (response && response.success) {
                // Check download option to show the correct message
                chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                    const message = options.downloadOption === 'any_scrape'
                        ? 'Job scraped and downloaded to your device!'
                        : 'Job scraped and saved to the backend!';
                    showStatus(message, 'success');
                    setTimeout(() => {
                        window.close();
                    }, 1500);
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
        const settings = await chrome.storage.sync.get(['llmSettings']);
        const llmSettings = settings.llmSettings; // Ensure we get it from sync
        
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
            
            if (response && response.success) {
                // Check download option to show the correct message
                chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                    const message = options.downloadOption === 'any_scrape'
                        ? 'Job scraped with LLM and downloaded to your device!'
                        : 'Job scraped with LLM and saved to the backend!';
                    showStatus(message, 'success');
                    setTimeout(() => {
                        window.close();
                    }, 1500);
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
            const settings = await chrome.storage.sync.get(['llmSettings']);
            const llmSettings = settings.llmSettings; // Ensure we get it from sync
            
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
                
                if (response && response.success) {
                    // Check download option to show the correct message
                    chrome.storage.sync.get({ downloadOption: 'any_scrape' }, (options) => {
                        const opt = options.downloadOption;
                        const willDownload = ['any_scrape', 'any_score', 'scrape_and_score'].includes(opt);
                        const message = willDownload
                            ? 'Job scraped, scored, and downloaded to your device!'
                            : 'Job scraped, scored, and saved to the backend!';
                        showStatus(message, 'success');
                        setTimeout(() => {
                            window.close();
                        }, 1500);
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

// View saved jobs (download CSV)
document.getElementById('viewJobs').addEventListener('click', async (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: 'downloadCSV' }, (response) => {
        if (response && response.success) {
            showStatus('CSV downloaded!', 'success');
        } else {
            showStatus('No jobs to download', 'info');
        }
    });
});

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
