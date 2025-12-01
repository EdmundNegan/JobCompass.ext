// Check if LLM is configured
document.addEventListener('DOMContentLoaded', async () => {
    const settings = await chrome.storage.local.get(['llmSettings']);
    const llmSettings = settings.llmSettings;
    
    const scrapeLLMBtn = document.getElementById('scrapeLLM');
    
    if (!llmSettings || !llmSettings.enabled || !llmSettings.apiKey) {
        scrapeLLMBtn.disabled = true;
        scrapeLLMBtn.title = 'Please configure LLM API in Options first';
    }
});

// Scrape with default method
document.getElementById('scrapeDefault').addEventListener('click', async () => {
    const btn = document.getElementById('scrapeDefault');
    btn.classList.add('loading');
    btn.disabled = true;
    
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
            btn.classList.remove('loading');
            btn.disabled = false;
            
            if (chrome.runtime.lastError) {
                showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
            }
            
            if (response && response.success) {
                showStatus('Job scraped and saved successfully!', 'success');
                setTimeout(() => {
                    window.close();
                }, 1500);
            } else {
                showStatus(response?.error || 'Failed to scrape job', 'error');
            }
        });
    } catch (error) {
        btn.classList.remove('loading');
        btn.disabled = false;
        showStatus('Error: ' + error.message, 'error');
    }
});

// Scrape with LLM API
document.getElementById('scrapeLLM').addEventListener('click', async () => {
    const btn = document.getElementById('scrapeLLM');
    btn.classList.add('loading');
    btn.disabled = true;
    
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab.id) {
            showStatus('Error: Could not access current tab', 'error');
            return;
        }
        
        // Get LLM settings
        const settings = await chrome.storage.local.get(['llmSettings']);
        const llmSettings = settings.llmSettings;
        
        if (!llmSettings || !llmSettings.enabled || !llmSettings.apiKey) {
            showStatus('Please configure LLM API in Options first', 'error');
            btn.classList.remove('loading');
            btn.disabled = false;
            return;
        }
        
        // Send message to background script to scrape with LLM
        chrome.runtime.sendMessage({
            action: 'scrape',
            method: 'llm',
            tabId: tab.id,
            settings: llmSettings
        }, (response) => {
            btn.classList.remove('loading');
            btn.disabled = false;
            
            if (chrome.runtime.lastError) {
                showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
            }
            
            if (response && response.success) {
                showStatus('Job scraped with LLM and saved successfully!', 'success');
                setTimeout(() => {
                    window.close();
                }, 1500);
            } else {
                const errorMsg = response?.error || 'Failed to scrape job with LLM';
                showStatus('LLM Scraping Failed: ' + errorMsg, 'error');
            }
        });
    } catch (error) {
        btn.classList.remove('loading');
        btn.disabled = false;
        showStatus('Error: ' + error.message, 'error');
    }
});

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

