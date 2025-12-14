// Clear badge text when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({
        text: ""
    });
    
    // Create context menu item for options
    chrome.contextMenus.create({
        id: 'openOptions',
        title: 'JobCompass Settings',
        contexts: ['action']
    });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'openOptions') {
        chrome.runtime.openOptionsPage();
    }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scrape') {
        handleScrapeRequest(request, request.tabId, request.method, request.settings, request.score)
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message });
            });
        return true; // Indicates we will send a response asynchronously
    }
    
    if (request.action === 'forceSaveJob') {
        forceSaveJob(request.job, request.tabId, request.triggerScore, request.settings)
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
    
    if (request.action === 'downloadCSV') {
        (async () => {
            const data = await chrome.storage.local.get({ jobs: [] });
            const jobs = data.jobs;
            if (jobs && jobs.length > 0) {
                await downloadJobsAsCSV(jobs);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, error: 'No jobs saved' });
            }
        })();
        return true;
    }

    if (request.action === 'scoreSavedJobs') {
        scoreDesirabilityWithLLM('missing')
            .then(async () => {
                await scoreEligibilityWithLLM('missing');
                const options = await chrome.storage.sync.get({ downloadOption: 'any_scrape' });
                if (options.downloadOption === 'any_score') {
                    const data = await chrome.storage.local.get({ jobs: [] });
                    await downloadJobsAsCSV(data.jobs);
                }
                sendResponse({ success: true });
            })
            .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.action === 'clearJobs') {
        chrome.storage.local.set({ jobs: [] }, () => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                // Reset badge count
                chrome.action.setBadgeText({ text: "" });
                sendResponse({ success: true });
            }
        });
        return true;
    }
    
    if (request.action === 'updateBadge') {
        const count = request.count;
        chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
        sendResponse({ success: true });
        return true;
    }
    
    if (request.action === 'getJobs') {
        chrome.storage.local.get({ jobs: [] }, (data) => {
            sendResponse({ success: true, jobs: data.jobs });
        });
        return true;
    }
});

// Function to handle scrape requests from popup
async function handleScrapeRequest(request, tabId, method, llmSettings, triggerScore = false) {
    if (!tabId) {
        throw new Error('No tab ID provided');
    }

    try {
        let job;
        
        if (method === 'llm' && llmSettings) {
            // Use LLM API for scraping
            console.log("Using LLM API for scraping...");
            job = await scrapeJobWithLLM(tabId, llmSettings);
        } else {
            // Use default DOM-based scraping
            const [injectionResult] = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: scrapeJobFromPage
            });
            job = injectionResult.result;
        }

        if (!job || !job.found) {
            return { success: false, error: 'No job found on the page.' };
        }

        console.log("Scraped job:", job.job);
        if (job.debug) {
            console.log("Scrape debug:", job.debug);
        }

        // Add scraped timestamp
        job.job.scrapedAt = new Date().toISOString();

        // Check for duplicate jobs
        const data = await chrome.storage.local.get({ jobs: [] });
        let jobs = data.jobs;
        
        const duplicate = findDuplicateJob(jobs, job.job);
        if (duplicate && !request?.forceSave) {
            return { 
                success: false, 
                isDuplicate: true, 
                duplicateInfo: {
                    title: duplicate.job?.title || duplicate.title,
                    company: duplicate.job?.company || duplicate.company,
                    scrapedAt: duplicate.job?.scrapedAt || duplicate.scrapedAt
                },
                scrapedJob: job // Return the scraped job for potential force save
            };
        }
        
        jobs.push(job);
        
        await chrome.storage.local.set({ jobs });

        // Score the job only if requested (Scrape & Score button)
        try {
            if (triggerScore) {
                await scoreDesirabilityWithLLM('latest', llmSettings);
                await scoreEligibilityWithLLM('latest', llmSettings);
                // Refresh jobs from storage to get the scores for CSV download
                const updatedData = await chrome.storage.local.get({ jobs: [] });
                jobs = updatedData.jobs;
            }
        } catch (err) {
            console.error("Error during scoring:", err);
        }

        console.log("Job saved. Total jobs:", jobs.length);

        // Show count of saved jobs on the badge
        await chrome.action.setBadgeText({
            tabId: tabId,
            text: String(jobs.length),
        });

        // Check download option before downloading CSV
        const settings = await chrome.storage.sync.get({ downloadOption: 'any_scrape' });
        const opt = settings.downloadOption;
        
        if (opt === 'any_scrape' || 
           (opt === 'scrape_and_score' && triggerScore) || 
           (opt === 'any_score' && triggerScore)) {
            await downloadJobsAsCSV(jobs);
        }

        return { success: true, jobCount: jobs.length };
    } catch (error) {
        console.error("Error scraping job:", error);
        throw error;
    }
}

// Find duplicate job by URL or title+company combination
function findDuplicateJob(jobs, newJob) {
    if (!jobs || !newJob) return null;
    
    const newUrl = newJob.url?.toLowerCase().trim();
    const newTitle = newJob.title?.toLowerCase().trim();
    const newCompany = newJob.company?.toLowerCase().trim();
    
    for (const item of jobs) {
        const existingJob = item.job || item;
        const existingUrl = existingJob.url?.toLowerCase().trim();
        const existingTitle = existingJob.title?.toLowerCase().trim();
        const existingCompany = existingJob.company?.toLowerCase().trim();
        
        // Check by URL (most reliable)
        if (newUrl && existingUrl && newUrl === existingUrl) {
            return item;
        }
        
        // Check by title + company combination
        if (newTitle && existingTitle && newCompany && existingCompany) {
            if (newTitle === existingTitle && newCompany === existingCompany) {
                return item;
            }
        }
    }
    
    return null;
}

// Force save a job (used when user confirms saving a duplicate)
async function forceSaveJob(job, tabId, triggerScore = false, llmSettings = null) {
    try {
        const data = await chrome.storage.local.get({ jobs: [] });
        let jobs = data.jobs;
        jobs.push(job);
        
        await chrome.storage.local.set({ jobs });

        // Score the job if requested
        if (triggerScore && llmSettings) {
            try {
                await scoreDesirabilityWithLLM('latest', llmSettings);
                await scoreEligibilityWithLLM('latest', llmSettings);
                const updatedData = await chrome.storage.local.get({ jobs: [] });
                jobs = updatedData.jobs;
            } catch (err) {
                console.error("Error during scoring:", err);
            }
        }

        console.log("Job force saved. Total jobs:", jobs.length);

        // Update badge
        if (tabId) {
            await chrome.action.setBadgeText({
                tabId: tabId,
                text: String(jobs.length),
            });
        }

        // Check download option
        const settings = await chrome.storage.sync.get({ downloadOption: 'any_scrape' });
        const opt = settings.downloadOption;
        
        if (opt === 'any_scrape' || 
           (opt === 'scrape_and_score' && triggerScore) || 
           (opt === 'any_score' && triggerScore)) {
            await downloadJobsAsCSV(jobs);
        }

        return { success: true, jobCount: jobs.length };
    } catch (error) {
        console.error("Error force saving job:", error);
        throw error;
    }
}

function getPageContent() {
    const maxLength = 50000; // Increased to capture full job descriptions

    // --- STRATEGY 1: Check for JSON-LD Structured Data (The "Gold Standard") ---
    // This is hidden data specifically formatted for bots/search engines.
    // It often contains the exact salary, address, and requirements.
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    let structuredData = null;

    for (const script of jsonLdScripts) {
        try {
            const data = JSON.parse(script.innerText);
            // Look for JobPosting schema
            if (data['@type'] === 'JobPosting' || data['@context'] === 'http://schema.org') {
                structuredData = data;
                break;
            }
        } catch (e) { /* ignore parse errors */ }
    }

    // --- STRATEGY 2: Global Text Extraction (The Backup) ---
    // Instead of looking for specific containers (which might miss sidebars),
    // we clean the entire body and extract all visible text.
    
    const clone = document.body.cloneNode(true);

    // Aggressive cleaning to remove noise so we can safely read the whole body
    const removeSelectors = [
        'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', // Technical
        'nav', 'footer', 'header', '[role="navigation"]', '[role="banner"]', // Structural noise
        'button', 'input', 'select', 'textarea', // Form elements (often irrelevant)
        '.ad', '.advertisement', '.cookie-banner', '.modal' // Common noise classes
    ];
    
    clone.querySelectorAll(removeSelectors.join(',')).forEach(el => el.remove());

    // Helper: Better text extraction that respects block elements
    // This creates cleaner spacing than standard innerText
    function getFormattedText(element) {
        let text = '';
        
        // Walk the tree to capture text nodes
        const walker = document.createTreeWalker(
            element, 
            NodeFilter.SHOW_TEXT, 
            null, 
            false
        );

        let node;
        while (node = walker.nextNode()) {
            const trimmed = node.textContent.trim();
            if (trimmed.length > 0) {
                // Check parent tag to decide on formatting
                const parentTag = node.parentElement ? node.parentElement.tagName.toLowerCase() : '';
                
                // Add newlines for block elements, spaces for inline
                const isBlock = ['div', 'p', 'h1', 'h2', 'h3', 'li', 'br', 'tr'].includes(parentTag);
                text += (isBlock ? '\n' : ' ') + trimmed;
            }
        }
        return text;
    }

    let rawText = getFormattedText(clone);
    
    // Clean up excessive whitespace
    rawText = rawText.replace(/\n\s*\n/g, '\n').trim();

    // If we found JSON-LD, prepend it to the text. 
    // The LLM will prioritize the structured JSON but fall back to text for descriptions.
    let finalContent = rawText;
    if (structuredData) {
        finalContent = `*** PRIORITY DATA (JSON-LD) ***\n${JSON.stringify(structuredData, null, 2)}\n\n*** VISIBLE PAGE TEXT ***\n${rawText}`;
    }

    // Limit content length
    const truncatedContent = finalContent.length > maxLength 
        ? finalContent.substring(0, maxLength) + '...' 
        : finalContent;

    return {
        url: window.location.href,
        title: document.title,
        content: truncatedContent,
        // We don't need the HTML field anymore as text extraction is more robust
        hasStructuredData: !!structuredData 
    };
}
// Function to call LLM API and extract job information
async function scrapeJobWithLLM(tabId, settings) {
    try {
        // Get page content using the NEW getPageContent function
        const [contentResult] = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: getPageContent
        });
        
        const pageData = contentResult.result;
        
        // --- UPDATED PROMPT STRATEGY ---
        const prompt = `You are an expert job data extractor. Analyze the provided webpage content, which may contain two sections: "PRIORITY DATA (JSON-LD)" and "VISIBLE PAGE TEXT".

STRATEGY:
1. First, check the "PRIORITY DATA" (JSON-LD). This is the source of truth for Title, Company, Location, Salary, and Posting Dates.
2. Next, read the "VISIBLE PAGE TEXT" to find the full Job Description, specific Skills, and nuances (like "Hybrid" specifics or "Benefits") that might be missing from the JSON.
3. If data exists in both, prioritize the JSON-LD for accuracy, but use the Text to add detail.

EXTRACT fields into this JSON structure (return "" if not found):
{
  "title": "Job title (prioritize JSON-LD 'title')",
  "company": "Company name (prioritize JSON-LD 'hiringOrganization')",
  "locations": "Location(s). If remote, specify 'Remote'. If JSON-LD has address, format it clearly.",
  "jobType": "e.g., 'Full-time', 'Contract' (check JSON-LD 'employmentType')",
  "workMode": "Determine if 'Remote', 'Hybrid', or 'On-site' based on location context or keywords.",
  "experienceLevel": "e.g., 'Senior', '3+ years' (check JSON-LD 'experienceRequirements' or text)",
  "educationLevel": "e.g., 'Bachelor's', 'PhD' (check JSON-LD 'educationRequirements' or text)",
  "duration": "Contract duration if applicable",
  "salaryAndBenefits": "Combine base salary (check JSON-LD 'baseSalary' min/max) with mentioned benefits.",
  "visaSponsorship": "Look for keywords like 'sponsorship', 'H1B', 'work authorization'.",
  "responsibilities": "List of key duties from the description text; separated by ';'.",
  "requiredSkills": "List of MUST HAVE skills/qualifications; separated by ';'.",
  "preferredSkills": "List of NICE TO HAVE skills; separated by ';'.",
  "description": "The full, cleaned job description text. Do not truncate. Use markdown for paragraphs/bullets."
}

Webpage URL: ${pageData.url}
Page Title: ${pageData.title}

*** CONTENT START ***
${pageData.content}
*** CONTENT END ***

Return ONLY valid JSON. No markdown formatting (no \`\`\`json).`;

        // Ensure endpoint is set
        if (!settings.endpoint) {
            if (settings.provider === 'openai') {
                settings.endpoint = 'https://api.openai.com/v1/chat/completions';
            } else if (settings.provider === 'anthropic') {
                settings.endpoint = 'https://api.anthropic.com/v1/messages';
            } else if (settings.provider === 'gemini') {
                settings.endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
            }
        }
        
        // Call LLM API based on provider
        let response;
        if (settings.provider === 'anthropic') {
            response = await callAnthropicAPI(settings, prompt);
        } else if (settings.provider === 'openai') {
            response = await callOpenAIAPI(settings, prompt);
        } else if (settings.provider === 'gemini') {
            response = await callGeminiAPI(settings, prompt);
        } else {
            throw new Error('Unknown API provider. Please select OpenAI, Anthropic, or Gemini.');
        }
        
        // Parse LLM response
        const jobData = parseLLMResponse(response, pageData.url);
        
        if (!jobData.title && !jobData.description) {
            throw new Error('LLM API did not extract any job information.');
        }
        
        return {
            found: true,
            job: {
                source: new URL(pageData.url).hostname,
                url: pageData.url,
                title: jobData.title,
                company: jobData.company,
                locations: jobData.locations,
                jobType: jobData.jobType,
                workMode: jobData.workMode,
                experienceLevel: jobData.experienceLevel,
                educationLevel: jobData.educationLevel,
                duration: jobData.duration,
                salaryAndBenefits: jobData.salaryAndBenefits,
                visaSponsorship: jobData.visaSponsorship,
                responsibilities: jobData.responsibilities,
                requiredSkills: jobData.requiredSkills,
                preferredSkills: jobData.preferredSkills,
                description: jobData.description
            },
            debug: {
                source: 'llm-api',
                provider: settings.provider,
                model: settings.model,
                hasStructuredData: pageData.hasStructuredData // Useful for debugging
            }
        };
    } catch (error) {
        console.error('LLM scraping error:', error);
        throw error;
    }
}

// Function to score desirability using LLM
async function scoreDesirabilityWithLLM(target = 'latest', providedLlmSettings = null) {
    try {
        // 1. Get Jobs
        const data = await chrome.storage.local.get({ jobs: [] });
        const jobs = data.jobs;
        if (jobs.length === 0) return;

        // 2. Get Settings
        const settingsData = await chrome.storage.sync.get(['scoringSettings', 'llmScoringSettings']);
        const scoringSettings = settingsData.scoringSettings;
        
        // Use provided settings (from scrape request) or fall back to stored settings
        const llmSettings = providedLlmSettings || settingsData.llmScoringSettings;

        if (!scoringSettings || !scoringSettings.enabled || !scoringSettings.desirabilityCriteria) {
            console.log("Scoring disabled or no criteria found.");
            return;
        }

        if (!llmSettings || !llmSettings.apiKey) {
            console.error("No API settings available for scoring.");
            return;
        }

        // 3. Identify target jobs
        let indicesToScore = [];
        if (target === 'latest') {
            indicesToScore.push(jobs.length - 1);
        } else {
            // Score all jobs that don't have a score yet or missing summary
            jobs.forEach((job, index) => {
                if (job.job && (job.job.desirabilityScore === undefined || job.job.desirabilityScore === null || !job.job.desirabilitySummary)) {
                    indicesToScore.push(index);
                }
            });
        }

        if (indicesToScore.length === 0) return;

        // 4. Process each job
        for (const index of indicesToScore) {
            const jobWrapper = jobs[index];
            const job = jobWrapper.job;
            const criteria = scoringSettings.desirabilityCriteria.filter(c => c.priority !== 'exclude');

            if (criteria.length === 0) continue;

            // Construct Prompt
            const criteriaText = criteria.map(c => `- Category: "${c.name}", Preference: "${c.preference}", Priority: "${c.priority}"`).join('\n');
            
            const prompt = `Evaluate the following job against the user's desirability criteria.
            
Job Details:
Title: ${job.title}
Company: ${job.company}
Location: ${job.locations}
Type: ${job.jobType}
Work Mode: ${job.workMode}
Experience Level: ${job.experienceLevel}
Education Level: ${job.educationLevel}
Duration: ${job.duration}
Salary and Benefits: ${job.salaryAndBenefits}
Visa Sponsorship: ${job.visaSponsorship}
Responsibilities: ${job.responsibilities}
Required Skills: ${job.requiredSkills}
Preferred Skills: ${job.preferredSkills}
URL: ${job.url}
Source: ${job.source}

User Criteria:
${criteriaText}

Scoring Logic:
1. If the information for a category does not exist in the job details, extract information based on Description.
2. For 'mandatory' priority: if the job clearly does not match the preference, return 0. Else return 50.
3. For other priorities: rate the match from 0 to 100 based on the preference.

Return a JSON object with:
1. "scores": array of objects with "name" (category name) and "score" (number).
2. "summary": a brief summary (max 2 sentences) explaining the key reasons for the score (highlighting high matches and major gaps).

Example: { "scores": [{ "name": "Role category", "score": 80 }, ...], "summary": "Strong match for role and location, but salary information is missing." }
Return ONLY valid JSON.`;

            // Call LLM
            let response;
            if (llmSettings.provider === 'anthropic') {
                response = await callAnthropicAPI(llmSettings, prompt);
            } else if (llmSettings.provider === 'openai') {
                response = await callOpenAIAPI(llmSettings, prompt);
            } else if (llmSettings.provider === 'gemini') {
                response = await callGeminiAPI(llmSettings, prompt);
            }

            // Parse and Calculate
            const scoresData = parseLLMScoringResponse(response);
            const calculation = calculateWeightedScore(scoresData, criteria);
            
            // Update Job
            jobs[index].job.desirabilityScore = calculation.finalScore;
            jobs[index].job.desirabilityBreakdown = calculation.breakdown;
            jobs[index].job.desirabilitySummary = scoresData.summary || "";
            
            console.log(`Job scored: ${calculation.finalScore}`);
        }

        // 5. Save Jobs
        await chrome.storage.local.set({ jobs });

    } catch (e) {
        console.error("Error in scoreDesirabilityWithLLM:", e);
    }
}

// Function to score eligibility using LLM
async function scoreEligibilityWithLLM(target = 'latest', providedLlmSettings = null) {
    try {
        // 1. Get Jobs
        const data = await chrome.storage.local.get({ jobs: [] });
        const jobs = data.jobs;
        if (jobs.length === 0) return;

        // 2. Get Settings
        const settingsData = await chrome.storage.sync.get(['scoringSettings', 'llmScoringSettings']);
        const scoringSettings = settingsData.scoringSettings;
        
        // Use provided settings (from scrape request) or fallback to stored settings
        const llmSettings = providedLlmSettings || settingsData.llmScoringSettings;

        if (!scoringSettings || !scoringSettings.enabled || !scoringSettings.eligibilityCriteria) {
            console.log("Eligibility scoring disabled or no criteria found.");
            return;
        }

        if (!llmSettings || !llmSettings.apiKey) {
            console.error("No API settings available for eligibility scoring.");
            return;
        }

        // 3. Identify target jobs
        let indicesToScore = [];
        if (target === 'latest') {
            indicesToScore.push(jobs.length - 1);
        } else {
            // Score all jobs that don't have an eligibility score yet
            jobs.forEach((job, index) => {
                if (job.job && (job.job.eligibilityScore === undefined || job.job.eligibilityScore === null)) {
                    indicesToScore.push(index);
                }
            });
        }

        if (indicesToScore.length === 0) return;

        // 4. Process each job
        for (const index of indicesToScore) {
            const jobWrapper = jobs[index];
            const job = jobWrapper.job;
            const criteria = scoringSettings.eligibilityCriteria.filter(c => c.weight > 0);

            if (criteria.length === 0) continue;

            // Construct Prompt
            const userDetails = criteria.map(c => `- ${c.name}: ${c.details}`).join('\n');
            const prompt = `Evaluate the user's eligibility for the following job based on their provided details.

Job Details:
Title: ${job.title}
Company: ${job.company}
Location: ${job.locations}
Type: ${job.jobType}
Work Mode: ${job.workMode}
Experience Level: ${job.experienceLevel}
Education Level: ${job.educationLevel}
Duration: ${job.duration}
Salary and Benefits: ${job.salaryAndBenefits}
Visa Sponsorship: ${job.visaSponsorship}
Responsibilities: ${job.responsibilities}
Required Skills: ${job.requiredSkills}
Preferred Skills: ${job.preferredSkills}
URL: ${job.url}
Source: ${job.source}

User Details:
${userDetails}

Scoring Logic:
For each category, rate the user's match from 0 to 100 based on how well their details align with the job requirements.
- 0 means no match or significant mismatch
- 100 means perfect match
Consider the job description and requirements when evaluating.

Return a JSON object with:
1. "scores": array of objects with "name" (category name) and "score" (number).
2. "summary": a brief summary (max 2 sentences) explaining the key reasons for the eligibility score.

Example: { "scores": [{ "name": "Experience Level", "score": 80 }, ...], "summary": "Strong experience match but education level is slightly below requirements." }
Return ONLY valid JSON.`;

            // Call LLM
            let response;
            if (llmSettings.provider === 'anthropic') {
                response = await callAnthropicAPI(llmSettings, prompt);
            } else if (llmSettings.provider === 'openai') {
                response = await callOpenAIAPI(llmSettings, prompt);
            } else if (llmSettings.provider === 'gemini') {
                response = await callGeminiAPI(llmSettings, prompt);
            }

            // Parse and Calculate
            const scoresData = parseLLMScoringResponse(response);
            const calculation = calculateWeightedEligibilityScore(scoresData, criteria);

            // Update Job
            jobs[index].job.eligibilityScore = calculation.finalScore;
            jobs[index].job.eligibilityBreakdown = calculation.breakdown;
            jobs[index].job.eligibilitySummary = scoresData.summary || "";

            console.log(`Job eligibility scored: ${calculation.finalScore}`);
        }

        // 5. Save Jobs
        await chrome.storage.local.set({ jobs });

    } catch (e) {
        console.error("Error in scoreEligibilityWithLLM:", e);
    }
}

function calculateWeightedEligibilityScore(aiScores, criteria) {
    const scoreMap = {};
    if (aiScores && aiScores.scores) {
        aiScores.scores.forEach(s => { if (s.name) scoreMap[s.name] = s.score; });
    }

    let totalWeightedScore = 0;
    let totalWeight = 0;
    const breakdown = [];

    for (const criterion of criteria) {
        const name = criterion.name;
        const weight = criterion.weight;
        const score = (scoreMap[name] !== undefined) ? scoreMap[name] : 50; // Default 50 if missing

        breakdown.push({ category: name, score: score, weight: weight });

        totalWeightedScore += (score * weight);
        totalWeight += weight;
    }

    // Calculate weighted average
    const finalScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;
    return { finalScore, breakdown };
}

function calculateWeightedScore(aiScores, criteria) {
    const PRIORITY_WEIGHTS = { 'high': 3, 'medium': 2, 'low': 1, 'mandatory': 0, 'exclude': 0 };
    const scoreMap = {};
    if (aiScores && aiScores.scores) {
        aiScores.scores.forEach(s => { if (s.name) scoreMap[s.name] = s.score; });
    }

    let totalWeightedScore = 0;
    let totalWeight = 0;
    let mandatoryFailed = false;
    const breakdown = [];

    for (const criterion of criteria) {
        const name = criterion.name;
        const priority = criterion.priority.toLowerCase();
        const score = (scoreMap[name] !== undefined) ? scoreMap[name] : 50; // Default 50 if missing
        const weight = PRIORITY_WEIGHTS[priority] !== undefined ? PRIORITY_WEIGHTS[priority] : 0;

        breakdown.push({ category: name, priority: priority, score: score, weight: weight });

        if (priority === 'mandatory') {
            if (score === 0) mandatoryFailed = true;
        } else if (priority !== 'exclude') {
            totalWeightedScore += (score * weight);
            totalWeight += weight;
        }
    }

    if (mandatoryFailed) return { finalScore: 0, breakdown };
    
    // Logic: sum of % of Total Score * Score by AI
    // This simplifies to: Sum(Score * Weight) / Sum(Weight)
    const finalScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;
    return { finalScore, breakdown };
}

function parseLLMScoringResponse(response) {
    try {
        let jsonStr = response.trim();
        jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("Error parsing scoring response", e);
        return { scores: [], summary: "" };
    }
}

// Function to call OpenAI-compatible API
async function callOpenAIAPI(settings, prompt) {
    const response = await fetch(settings.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
            model: settings.model,
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant that extracts structured information from web pages. Always return valid JSON only.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.3
            // No max_tokens limit - let the model use as much as needed
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
}

// Function to call Anthropic API
async function callAnthropicAPI(settings, prompt) {
    const response = await fetch(settings.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: settings.model,
            max_tokens: 16384, // High limit for full descriptions
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ]
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.content[0].text;
}

// Function to call Google Gemini API
async function callGeminiAPI(settings, prompt) {
    const model = settings.model || 'gemini-2.0-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': settings.apiKey
        },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        {
                            text: `You are a helpful assistant that extracts structured information from web pages. Always return valid JSON only.\n\n${prompt}`
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.3
                // No maxOutputTokens limit - let the model use as much as needed
            }
        })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts) {
        throw new Error('Invalid response format from Gemini API');
    }
    
    return data.candidates[0].content.parts[0].text;
}

// Function to parse LLM response and extract job data
function parseLLMResponse(llmResponse, url) {
    try {
        // Try to extract JSON from response (handle markdown code blocks)
        let jsonStr = llmResponse.trim();
        
        // Remove markdown code blocks if present
        jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        // Try to find JSON object in the response
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }
        
        const parsed = JSON.parse(jsonStr);
        
        return {
            title: parsed.title || "",
            company: parsed.company || "",
            locations: parsed.locations || "",
            jobType: parsed.jobType || "",
            workMode: parsed.workMode || "",
            experienceLevel: parsed.experienceLevel || "",
            educationLevel: parsed.educationLevel || "",
            duration: parsed.duration || "",
            salaryAndBenefits: parsed.salaryAndBenefits || "",
            visaSponsorship: parsed.visaSponsorship || "",
            responsibilities: parsed.responsibilities || "",
            requiredSkills: parsed.requiredSkills || "",
            preferredSkills: parsed.preferredSkills || "",
            description: parsed.description || ""
        };
    } catch (error) {
        console.error('Error parsing LLM response:', error);
        console.log('Raw LLM response:', llmResponse);
        
        // Fallback: try to extract fields using regex
        const titleMatch = llmResponse.match(/"title"\s*:\s*"([^"]+)"/i) || 
                          llmResponse.match(/title["\s:]+([^\n,}]+)/i);
        const companyMatch = llmResponse.match(/"company"\s*:\s*"([^"]+)"/i) || 
                            llmResponse.match(/company["\s:]+([^\n,}]+)/i);
        const locationMatch = llmResponse.match(/"locations?"\s*:\s*"([^"]+)"/i) || 
                             llmResponse.match(/location["\s:]+([^\n,}]+)/i);
        const descMatch = llmResponse.match(/"description"\s*:\s*"([^"]+)"/i) || 
                         llmResponse.match(/description["\s:]+([^\n,}]+)/i);
        
        return {
            title: titleMatch ? titleMatch[1].trim() : '',
            company: companyMatch ? companyMatch[1].trim() : '',
            locations: locationMatch ? locationMatch[1].trim() : '',
            description: descMatch ? descMatch[1].trim() : ''
        };
    }
}

// Function to scrape job details from the current page
function scrapeJobFromPage() {
    const debug = { source: "html", selectors: {}, tiers: [] };
    
    function getText(el) {
        if (!el) return "";
        if (el.tagName.toLowerCase() === 'meta') {
            return el.getAttribute('content') || '';
        }
        return el.innerText.trim();
    }

    function cleanIconTokens(text) {
        // Remove common Material icon names embedded in text
        return text.replace(/\b(location_on|place|work|business|apartment|map|room)\b/gi, '').trim();
    }

    function extractFromContainer(container, fieldType) {
        if (!container) return '';
        const clone = container.cloneNode(true);
        // Remove noise elements
        clone.querySelectorAll('script, style, link, button, input, noscript, nav, footer, header, iframe, svg').forEach(el => el.remove());
        let text = clone.textContent.trim();
        text = cleanIconTokens(text);
        return text;
    }

    // Helper function to extract details from text using keywords and regex
    function extractDetailsFromText(text) {
        const details = {
            jobType: '',
            workMode: '',
            experienceLevel: '',
            educationLevel: '',
            duration: '',
            salaryAndBenefits: '',
            visaSponsorship: '',
            responsibilities: '',
            requiredSkills: '',
            preferredSkills: ''
        };

        if (!text) return details;

        // Helper to find a section between two headings
        const getSection = (startRegex, endRegex) => {
            const startMatch = text.match(startRegex);
            if (!startMatch) return '';
            const startIndex = startMatch.index + startMatch[0].length;
            const remainingText = text.substring(startIndex);
            const endMatch = remainingText.match(endRegex);
            const endIndex = endMatch ? endMatch.index : -1;
            return (endIndex !== -1 ? remainingText.substring(0, endIndex) : remainingText).trim();
        };

        const lowerText = text.toLowerCase();

        // Job Type
        if (/\b(full-time|full time)\b/i.test(text)) details.jobType = 'Full-time';
        else if (/\b(part-time|part time)\b/i.test(text)) details.jobType = 'Part-time';
        else if (/\b(contract|freelance)\b/i.test(text)) details.jobType = 'Contract';
        else if (/\b(internship|intern)\b/i.test(text)) details.jobType = 'Internship';

        // Work Mode
        if (/\b(remote|work from home|wfh)\b/i.test(text)) details.workMode = 'Remote';
        else if (/\b(hybrid)\b/i.test(text)) details.workMode = 'Hybrid';
        else if (/\b(on-site|onsite|in office)\b/i.test(text)) details.workMode = 'On-site';

        // Experience Level
        const expMatch = text.match(/(\d{1,2})\s*(\+|-|to)\s*(\d{1,2})?\s*years?/i) || text.match(/(\d{1,2})\+?\s*years?/i);
        if (expMatch) {
            details.experienceLevel = expMatch[0];
        } else if (/\b(entry-level|entry level|graduate|student)\b/i.test(text)) {
            details.experienceLevel = 'Entry-level';
        } else if (/\b(senior-level|senior level|experie\.)\b/i.test(text)) {
            details.experienceLevel = 'Senior';
        }

        // Education Level
        if (/\b(undergraduate|bachelor's|bachelor|bs|ba)\b/i.test(text)) details.educationLevel = "Bachelor's Degree";
        else if (/\b(master's|master|ms|ma)\b/i.test(text)) details.educationLevel = "Master's Degree";
        else if (/\b(phd|doctorate)\b/i.test(text)) details.educationLevel = 'PhD';

        // Duration / Start Time
        const durationMatch = text.match(/(\d+\s*(months?|years?)\s*contract|\b(internship|contract)\b\s*for\s*\d+\s*months?|\b(\w+)-(week|month|year)\s+internship\b)/i);
        if (durationMatch) details.duration = durationMatch[0];

        // Salary and Benefits
        const salaryMatch = text.match(/(\$|€|£|CAD)\s?[\d,.]+\s*-\s*(\$|€|£|CAD)?\s?[\d,.]+/i);
        if (salaryMatch) details.salaryAndBenefits = salaryMatch[0];

        // Visa Sponsorship
        if (/\b(visa|sponsorship)\b/i.test(text) && !/\b(no|not|unable to)\s+(visa|sponsorship)\b/i.test(text)) details.visaSponsorship = 'Possibly available';
        if (/\b(no|not|unable to)\s+(visa|sponsorship)\b/i.test(text)) details.visaSponsorship = 'Not available';

        // Section-based extraction (best effort)
        const allHeadings = /\b(responsibilities|what you'll do|your role|qualifications|requirements|skills|preferred|nice to have|education|experience|who can apply)\b/i;

        details.responsibilities = getSection(
            /\b(responsibilities|what you'll do|your role|the role|day-to-day)\b/i, allHeadings
        );
        details.requiredSkills = getSection(
            /\b(basic qualifications|requirements|required skills|minimum qualifications|experience|skills|who can apply)\b/i, allHeadings
        );
        details.preferredSkills = getSection(
            /\b(preferred qualifications|preferred skills|nice to have|bonus points)\b/i, allHeadings
        );

        return details;
    }

    // ===================================================================
    // PLATFORM-SPECIFIC SCRAPERS - Check these first before generic tiers
    // ===================================================================
    
    // Indeed.com specific scraper
    if (window.location.hostname.includes('indeed.com')) {
        debug.source = 'indeed-specific';
        debug.tiers.push('platform-specific');
        
        const indeedHeader = document.querySelector('.ia-JobHeader-information, [class*="JobHeader"]');
        let title = '', company = '', locations = '';
        
        if (indeedHeader) {
            // Title: h1 inside header
            const titleEl = indeedHeader.querySelector('h1');
            if (titleEl) {
                title = titleEl.textContent.trim();
                debug.selectors.title = 'indeed:h1';
            }
            
            // Company and Location: span text in format "Company - Location"
            const companyLocSpan = indeedHeader.querySelector('span[class*="css-"]');
            if (companyLocSpan) {
                const text = companyLocSpan.textContent.trim();
                const parts = text.split('-').map(p => p.trim());
                if (parts.length >= 2) {
                    company = parts[0];
                    locations = parts.slice(1).join(' - ');
                    debug.selectors.company = 'indeed:span-split';
                    debug.selectors.locations = 'indeed:span-split';
                } else if (parts.length === 1) {
                    company = parts[0];
                    debug.selectors.company = 'indeed:span';
                }
            }
        }
        
        // Description: .ia-JobDescription
        let description = '';
        const descEl = document.querySelector('.ia-JobDescription');
        if (descEl) {
            const clone = descEl.cloneNode(true);
            clone.querySelectorAll('script, style, button').forEach(el => el.remove());
            description = clone.innerText.trim();
            debug.selectors.description = 'indeed:.ia-JobDescription';
        }
        
        if (title || description) {
            const job = {
                source: window.location.hostname,
                url: window.location.href,
                title: title,
                company: company,
                locations: locations,
                description: description,
            };
            return { found: true, job: { ...job, ...extractDetailsFromText(description) }, debug };
        }
    }
    
    // LinkedIn specific scraper
    if (window.location.hostname.includes('linkedin.com')) {
        debug.source = 'linkedin-specific';
        debug.tiers.push('platform-specific');

        let title = '';
        let company = '';
        let locations = '';
        let description = '';

        // Title: avoid dynamic ember IDs; use stable selectors
        // Try unified top card header H1
        const titleH1 = document.querySelector('.job-details-jobs-unified-top-card__job-title h1, h1.jobs-unified-top-card__job-title');
        if (titleH1) {
            title = titleH1.textContent.trim();
            debug.selectors.title = 'linkedin:h1';
        } else {
            // Fallback: anchor within header that points to /jobs/view/
            const titleAnchor = document.querySelector('[data-test-app-aware-link][href*="/jobs/view/"]');
            if (titleAnchor) {
                title = titleAnchor.textContent.trim();
                debug.selectors.title = 'linkedin:app-aware-link /jobs/view/';
            }
        }

        // Company: prefer app-aware company link; then nearby company name container
        const companyLink = document.querySelector('.job-details-jobs-unified-top-card__company-name a');
        if (companyLink) {
            company = companyLink.textContent.trim();
            debug.selectors.company = 'linkedin:a[data-test-app-aware-link][href*="/company/"]';
        } else {
            const companyContainer = document.querySelector('.topcard__org-name-link, .jobs-unified-top-card__company-name, .jobs-unified-top-card__subtitle-primary-group a, .job-details-jobs-unified-top-card__company-name a');
            if (companyContainer) {
                company = companyContainer.textContent.trim();
                debug.selectors.company = 'linkedin:company-container';
            }
        }

        // Location: bullets in unified top card or low-emphasis text
        const locationBullet = document.querySelector('.job-details-jobs-unified-top-card__primary-description-container span');
        if (locationBullet) {
            locations = locationBullet.textContent.trim();
            debug.selectors.locations = 'linkedin:top-card-bullet';
        } else {
            const locationSpan = document.querySelector('[data-test-topcard-location]');
            if (locationSpan) {
                locations = locationSpan.textContent.trim();
                debug.selectors.locations = 'linkedin:[data-test-topcard-location]';
            }
        }

        // Description: common containers 
        const descSelectors = [
            '#job-details > div > p', 'div.jobs-description__content',
            'div.jobs-description__container',
            'section.jobs-description',
            'div[data-test-description]',
            'div[class*="jobs-description"]',
            'p[dir="ltr"]'
        ];
        for (const sel of descSelectors) {
            const el = root.querySelector(sel);
            if (el) {
                const clone = el.cloneNode(true);
                clone.querySelectorAll('script, style, button').forEach(n => n.remove());
                description = clone.innerText.trim();
                debug.selectors.description = `linkedin:${sel}`;
                break;
            }
        }

        if (title || description) {
            const job = {
                source: window.location.hostname,
                url: window.location.href,
                title,
                company,
                locations,
                description
            };
            return { found: true, 
                job: { ...job, ...extractDetailsFromText(description) }, 
                debug };
        }
    }

    // Add more platform-specific scrapers here
    // if (window.location.hostname.includes('glassdoor.com')) { ... }

    // ===================================================================
    // GENERIC THREE-TIER APPROACH (fallback if no platform match)
    // ===================================================================

    function scrapeSchemaJSON() {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                const graph = Array.isArray(data) ? data : (data['@graph'] || [data]);
                const jobPost = graph.find(item => item['@type'] === 'JobPosting');

                if (jobPost) {
                    // The description from schema can be HTML, so we need to handle it.
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = jobPost.description || '';
                    return {
                        title: jobPost.title,
                        company: jobPost.hiringOrganization?.name || '',
                        location: jobPost.jobLocation?.address?.addressLocality || '',
                        description: tempDiv.innerText.trim() || '',
                        url: jobPost.url || window.location.href
                    };
                }
            } catch (e) {
                console.error("JSON-LD parse error", e);
            }
        }
        return null;
    }

    // TIER 1: Schema.org JSON-LD
    const schemaJob = scrapeSchemaJSON();
    const jobData = {
        source: window.location.hostname,
        url: schemaJob?.url || window.location.href,
        title: schemaJob?.title || '',
        company: schemaJob?.company || '',
        locations: schemaJob?.location || '',
        description: schemaJob?.description || '',
        // Initialize new fields for default scraper
        jobType: '',
        workMode: '',
        experienceLevel: '',
        educationLevel: '',
        duration: '',
        salaryAndBenefits: '',
        visaSponsorship: '',
        responsibilities: '',
        requiredSkills: '',
        preferredSkills: ''
    };
    if (schemaJob) {
        debug.tiers.push('schema');
        if (jobData.title) debug.selectors.title = 'schema';
        if (jobData.company) debug.selectors.company = 'schema';
        if (jobData.locations) debug.selectors.locations = 'schema';
        if (jobData.description) debug.selectors.description = 'schema';
    }

    // TIER 2: Head metadata (og, twitter)
    const headMetaSelectors = {
        title: ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'head > title'],
        company: ['meta[property="og:site_name"]', 'meta[name="twitter:site"]'],
        locations: ['meta[property="og:locality"]', 'meta[name="geo.placename"]'],
        description: ['meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]']
    };

    for (const [field, selectors] of Object.entries(headMetaSelectors)) {
        if (!jobData[field === 'locations' ? 'locations' : field]) {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = getText(el);
                    if (text) {
                        jobData[field === 'locations' ? 'locations' : field] = text;
                        debug.selectors[field] = `meta:${sel}`;
                        if (!debug.tiers.includes('head-meta')) debug.tiers.push('head-meta');
                        break;
                    }
                }
            }
        }
    }

    // TIER 3: Body HTML - Title
    const titleSelectors = [
        'h1', '.job-title', '.jobTitle', 'job_title', '[data-job-title]', '[data-qa="job-title"]',
        'h1.title', '.title', '.position-title', '.job-name', '[itemprop="title"]', '.posting-title'
    ];
    if (!jobData.title) {
        for (const sel of titleSelectors) {
            const el = document.querySelector(sel);
            if (el) {
                const text = getText(el);
                if (text) {
                    jobData.title = text;
                    debug.selectors.title = `body:${sel}`;
                    if (!debug.tiers.includes('body')) debug.tiers.push('body');
                    break;
                }
            }
        }
    }

    // TIER 3: Body HTML - Company
    if (!jobData.company) {
        // Try containers first
        const companyContainers = document.querySelectorAll('[class*="company"], [class*="employer"], [class*="organization"], [data-company]');
        for (const container of companyContainers) {
            const text = extractFromContainer(container, 'company');
            if (text && text.length > 0 && text.length < 200) {
                jobData.company = text;
                debug.selectors.company = `body:container:${container.className || container.tagName}`;
                if (!debug.tiers.includes('body')) debug.tiers.push('body');
                break;
            }
        }

        // Fallback to specific selectors
        if (!jobData.company) {
            const companySelectors = [
                '.company', '.job-company', '.jobCompany', '[data-company]', '.employer',
                '.organization', '.company-name', '.employer-name'
            ];
            for (const sel of companySelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = getText(el);
                    if (text) {
                        jobData.company = text;
                        debug.selectors.company = `body:${sel}`;
                        if (!debug.tiers.includes('body')) debug.tiers.push('body');
                        break;
                    }
                }
            }
        }

        // Amazon-style meta line: "Job ID: 3059253 | Amazon.com Services LLC"
        if (!jobData.company) {
            const metaEl = document.querySelector('p.meta, .meta, [class*="meta"]');
            if (metaEl) {
                const metaText = metaEl.innerText.trim();
                const pipeMatch = metaText.match(/\|\s*(.+)$/);
                if (pipeMatch && pipeMatch[1]) {
                    jobData.company = pipeMatch[1].trim();
                    debug.selectors.company = 'body:meta-pipe';
                    if (!debug.tiers.includes('body')) debug.tiers.push('body');
                } else {
                    const labelMatch = metaText.match(/Company\s*:\s*(.+)$/i);
                    if (labelMatch && labelMatch[1]) {
                        jobData.company = labelMatch[1].trim();
                        debug.selectors.company = 'body:meta-label';
                        if (!debug.tiers.includes('body')) debug.tiers.push('body');
                    }
                }
            }
        }
    }

    // TIER 3: Body HTML - Location
    if (!jobData.locations) {
        // Try containers first
        const locationContainers = document.querySelectorAll('[class*="location"], [class*="city"], [class*="address"], [data-location], [data-testid="location"]');
        for (const container of locationContainers) {
            let text = extractFromContainer(container, 'location');
            if (text && text.length > 0 && text.length < 300) {
                jobData.locations = text;
                debug.selectors.locations = `body:container:${container.className || container.getAttribute('data-testid') || container.tagName}`;
                if (!debug.tiers.includes('body')) debug.tiers.push('body');
                break;
            }
        }

        // Fallback to specific selectors
        if (!jobData.locations) {
            const locationSelectors = [
                '.location', '.job-location', '.jobLocation', '[data-location]', '[data-qa="location"]',
                '.city', '.place', '.job-place', '.address', '.job-address', '[itemprop="jobLocation"]',
                '.location-text', '[data-testid="location"]'
            ];
            for (const sel of locationSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    let text = cleanIconTokens(getText(el));
                    if (text) {
                        jobData.locations = text;
                        debug.selectors.locations = `body:${sel}`;
                        if (!debug.tiers.includes('body')) debug.tiers.push('body');
                        break;
                    }
                }
            }
        }
    }

    // TIER 3: Body HTML - Description
    if (!jobData.description) {
        const descriptionContainerSelectors = [
            '#job-description', '.job-details-content', '[itemprop="description"]',
            '.job-description', '.jobDescription', 'article.job-details',
            '[class*="description"]', '[class*="details"]',
            'article', 'main'
        ];

        let descriptionContainer = null;
        for (const selector of descriptionContainerSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                descriptionContainer = element;
                debug.selectors.description = `body:${selector}`;
                if (!debug.tiers.includes('body')) debug.tiers.push('body');
                break;
            }
        }

        if (descriptionContainer) {
            const clone = descriptionContainer.cloneNode(true);
            clone.querySelectorAll('script, style, link, button, input, noscript, nav, footer, header').forEach(el => el.remove());

            const blockElements = ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'HR', 'TR', 'TABLE', 'UL', 'OL'];
            let parts = [];

            function extractTextWithFormatting(element) {
                for (const child of element.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const text = child.textContent.trim();
                        if (text) {
                            if (parts.length > 0 && !/\s$/.test(parts[parts.length - 1])) {
                               parts.push(' ');
                            }
                            parts.push(text);
                        }
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        extractTextWithFormatting(child);
                        if (blockElements.includes(child.tagName.toUpperCase())) {
                            if (parts.length > 0 && parts[parts.length - 1] !== '\n') {
                                parts.push('\n');
                            }
                        }
                    }
                }
            }

            extractTextWithFormatting(clone);
            jobData.description = parts.join('').replace(/(\n\s*){2,}/g, '\n\n').trim();
        }
    }

    // If we found at least a title or description, consider it a job page
    if (jobData.title || jobData.description) {
        debug.source = debug.tiers.join('+') || 'html';
        return { found: true, job: { ...jobData, ...extractDetailsFromText(jobData.description) }, debug };
    }

    // If nothing matched:
    return { found: false };
}

// Function to build CSV string from jobs and download as job_listings.csv
async function downloadJobsAsCSV(jobs) {
    if (!jobs || !jobs.length) return;

    // Get current scoring settings
    const data = await chrome.storage.sync.get(['scoringSettings']);
    const scoringSettings = data.scoringSettings || {};
    const desirabilityWeight = scoringSettings.desirabilityWeight;
    const eligibilityWeight = scoringSettings.eligibilityWeight;
    const threshold = scoringSettings.threshold;
    
    const overallScoreHeader = `Overall Score (${desirabilityWeight}:${eligibilityWeight})`;
    const applyHeader = "Apply";

    const headers = [
        "Title", "Company", "Locations", "Job Type", "Work Mode",
        "Experience Level", "Education Level", "Duration/Start time",
        "Salary and Benefits", "Visa Sponsorship", "Responsibility",
        "Required Skills", "Preferred Skills", "Description",
        "URL", "Source", "Scraped At",
        "Desirability Score", "Desirability Summary",
        "Eligibility Score", "Eligibility Summary",
        overallScoreHeader, applyHeader
    ];
    const csvRows = [];

    // Header row
    // Quote headers to be safe
    csvRows.push(headers.map(h => `"${h}"`).join(","));

    // Check if we need to recalculate overall scores
    let needsRecalculation = false;
    const existingOverallHeaderIndex = jobs.some(job => {
        if (job.job && job.job.overallScore !== undefined) {
            // Check if the header matches current weights
            const jobOverallHeader = job.job.overallScoreHeader;
            if (!jobOverallHeader || !jobOverallHeader.includes(`${desirabilityWeight}:${eligibilityWeight}`)) {
                needsRecalculation = true;
                return true;
            }
        }
        return false;
    });

    if (needsRecalculation) {
        // Clear existing overall scores if weights changed
        jobs.forEach(job => {
            if (job.job) {
                delete job.job.overallScore;
                delete job.job.overallScoreHeader;
                delete job.job.applyDecision;
                delete job.job.applyReason;
            }
        });
        await chrome.storage.local.set({ jobs });
    }

    // Calculate missing overall scores
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i].job;
        if (job && job.desirabilityScore !== undefined && job.eligibilityScore !== undefined && job.overallScore === undefined) {
            // Calculate overall score
            const overallScore = Math.round(
                (job.desirabilityScore * desirabilityWeight / 100) + 
                (job.eligibilityScore * eligibilityWeight / 100)
            );
            
            // Determine apply decision
            let applyDecision = "No";
            let applyReason = "";
            
            // Check threshold
            if (overallScore < threshold) {
                applyReason = `Below threshold (${overallScore} < ${threshold})`;
            } else {
                // Check mandatory requirements
                const mandatoryFailed = [];
                if (scoringSettings.desirabilityCriteria) {
                    scoringSettings.desirabilityCriteria.forEach(criterion => {
                        if (criterion.priority === 'mandatory') {
                            // Check if this mandatory criterion was scored 0
                            const breakdown = job.desirabilityBreakdown || [];
                            const criterionScore = breakdown.find(b => b.category === criterion.name);
                            if (criterionScore && criterionScore.score === 0) {
                                mandatoryFailed.push(criterion.name);
                            }
                        }
                    });
                }
                
                if (mandatoryFailed.length > 0) {
                    applyDecision = "No";
                    applyReason = `Does not meet mandatory requirement: ${mandatoryFailed.join(', ')}`;
                } else {
                    applyDecision = "Yes";
                }
            }
            
            // Store the calculated values
            jobs[i].job.overallScore = overallScore;
            jobs[i].job.overallScoreHeader = overallScoreHeader;
            jobs[i].job.applyDecision = applyDecision;
            jobs[i].job.applyReason = applyReason;
        }
    }
    
    // Save updated jobs
    await chrome.storage.local.set({ jobs });

    // Data rows
    for (const item of jobs) {
        if (!item || !item.job) continue; // Skip invalid items
        const jobData = item.job;

        let desirabilitySummaryCombined = jobData.desirabilitySummary || "";
        if (jobData.desirabilityBreakdown && Array.isArray(jobData.desirabilityBreakdown)) {
            const breakdownStr = jobData.desirabilityBreakdown
                .map(b => `${b.category}: ${b.score}`)
                .join(", ");
            if (breakdownStr) {
                desirabilitySummaryCombined = `[${breakdownStr}] ${desirabilitySummaryCombined}`;
            }
        }

        let eligibilitySummaryCombined = jobData.eligibilitySummary || "";
        if (jobData.eligibilityBreakdown && Array.isArray(jobData.eligibilityBreakdown)) {
            const breakdownStr = jobData.eligibilityBreakdown
                .map(b => `${b.category}: ${b.score}`)
                .join(", ");
            if (breakdownStr) {
                eligibilitySummaryCombined = `[${breakdownStr}] ${eligibilitySummaryCombined}`;
            }
        }

        const row = [
            jobData.title || "",
            jobData.company || "",
            jobData.locations || "",
            jobData.jobType || "",
            jobData.workMode || "",
            jobData.experienceLevel || "",
            jobData.educationLevel || "",
            jobData.duration || "",
            jobData.salaryAndBenefits || "",
            jobData.visaSponsorship || "",
            jobData.responsibilities || "",
            jobData.requiredSkills || "",
            jobData.preferredSkills || "",
            jobData.description || "",
            jobData.url || "",
            jobData.source || "",
            jobData.scrapedAt || "",
            jobData.desirabilityScore !== undefined ? jobData.desirabilityScore : "",
            desirabilitySummaryCombined,
            jobData.eligibilityScore !== undefined ? jobData.eligibilityScore : "",
            eligibilitySummaryCombined,
            jobData.overallScore !== undefined ? jobData.overallScore : "",
            jobData.applyDecision ? (jobData.applyDecision === "Yes" ? "Yes" : `No - ${jobData.applyReason || "Unknown reason"}`) : ""
        ].map((value) => {
            value = String(value);
            // Escape double quotes
            value = value.replace(/"/g, '""');
            // Remove newlines
            value = value.replace(/\r?\n|\r/g, " ");
            // Wrap in double quotes
            return `"${value}"`;
        }).join(",");
        csvRows.push(row);
    }

    // Prepend a Byte Order Mark (BOM) to the CSV content to ensure Excel opens it with UTF-8 encoding.
    const bom = "\uFEFF";
    const csvContent = csvRows.join("\n");
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent(bom + csvContent);

    chrome.downloads.download(
        {
            url,
            filename: "job_listings.csv",
            conflictAction: "overwrite",
            saveAs: false,
        }
    );
}

// Function to clear all job listings
function clearJobListings() {
    chrome.storage.local.set({ jobs: [] }, () => {
        console.log("Job listings cleared");
        // Reset badge
        chrome.action.setBadgeText({ text: "" });
    });
}

// Listen for commands
chrome.commands.onCommand.addListener((command) => {
    if (command === "clear_jobs") {
        clearJobListings();
    }
});
