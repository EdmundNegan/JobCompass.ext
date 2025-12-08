// Clear badge text when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({
        text: ""
    });
    
    // Create context menu item for options
    chrome.contextMenus.create({
        id: 'openOptions',
        title: 'JobCompass Options',
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
        handleScrapeRequest(request.tabId, request.method, request.settings)
            .then((result) => {
                sendResponse(result);
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message });
            });
        return true; // Indicates we will send a response asynchronously
    }
    
    if (request.action === 'downloadCSV') {
        chrome.storage.local.get({ jobs: [] }, (data) => {
            const jobs = data.jobs;
            if (jobs && jobs.length > 0) {
                downloadJobsAsCSV(jobs);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, error: 'No jobs saved' });
            }
        });
        return true;
    }
});

// Function to handle scrape requests from popup
async function handleScrapeRequest(tabId, method, llmSettings) {
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

        // Save the job and handle post-save actions
        const data = await chrome.storage.local.get({ jobs: [] });
        const jobs = data.jobs;
        jobs.push(job);
        
        await chrome.storage.local.set({ jobs });
        console.log("Job saved. Total jobs:", jobs.length);

        // Show count of saved jobs on the badge
        await chrome.action.setBadgeText({
            tabId: tabId,
            text: String(jobs.length),
        });

        // Check download option before downloading CSV
        const options = await chrome.storage.sync.get({ downloadOption: 'everytime' });
        if (options.downloadOption === 'everytime') {
            downloadJobsAsCSV(jobs);
        }

        return { success: true, jobCount: jobs.length };
    } catch (error) {
        console.error("Error scraping job:", error);
        throw error;
    }
}

// Function to get page content for LLM processing
function getPageContent() {
    // Remove script and style elements
    const clone = document.cloneNode(true);
    clone.querySelectorAll('script, style, link, button, input, noscript, nav, footer, header, iframe, svg').forEach(el => el.remove());
    
    // Get main content areas
    const mainContent = clone.querySelector('main, article, [role="main"], .content, #content, .job-description, .job-details');
    const content = mainContent ? mainContent.innerText : clone.body.innerText;
    
    // Limit content length to avoid token limits (keep first ~8000 chars)
    const maxLength = 8000;
    const truncatedContent = content.length > maxLength ? content.substring(0, maxLength) + '...' : content;
    
    return {
        url: window.location.href,
        title: document.title,
        content: truncatedContent,
        html: clone.body.innerHTML.substring(0, 10000) // Limited HTML for context
    };
}

// Function to call LLM API and extract job information
async function scrapeJobWithLLM(tabId, settings) {
    try {
        // Get page content
        const [contentResult] = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: getPageContent
        });
        
        const pageData = contentResult.result;
        
        // Prepare prompt for LLM
        const prompt = `Extract job listing information from the following webpage content. For any fields you cannot find, return an empty string "". Return a JSON object with the following structure:
{
  "title": "Job title",
  "company": "Company name",
  "locations": "Location(s) - can be multiple locations separated by commas",
  "jobType": "e.g., 'Full-time', 'Part-time', 'Contract', 'Internship'",
  "workMode": "e.g., 'Remote', 'Hybrid', 'On-site'",
  "experienceLevel": "e.g., 'Entry-level', 'Mid-level', 'Senior', 'Lead', '0-3 years'",
  "educationLevel": "e.g., 'Bachelor's Degree', 'Master's Degree', 'PhD'",
  "duration": "e.g., '6 months', '1 year contract'",
  "salaryAndBenefits": "Capture any mention of salary, stock options, bonuses, and benefits like health insurance, 401k, etc.",
  "visaSponsorship": "e.g., 'Visa sponsorship available', 'Not available', 'Case-by-case'",
  "responsibilities": "A list of job responsibilities, with each item separated by a semicolon ';'.",
  "requiredSkills": "A list of required skills or qualifications, with each item separated by a semicolon ';'.",
  "preferredSkills": "A list of preferred/bonus skills, with each item separated by a semicolon ';'.",
  "description": "A clean, readable, and well-formatted version of the full job description, with proper paragraphs and bullet points."
}

Webpage URL: ${pageData.url}
Page Title: ${pageData.title}

Content:
${pageData.content}

Return ONLY valid JSON, no additional text or markdown formatting.`;

        // Ensure endpoint is set (for backward compatibility)
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
            throw new Error('LLM API did not extract any job information. The response may be invalid or the page content may not contain job listing information.');
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
                model: settings.model
            }
        };
    } catch (error) {
        console.error('LLM scraping error:', error);
        // Don't fallback - throw error so user sees the failure message
        throw error;
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
            temperature: 0.3,
            max_tokens: 2000
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
            max_tokens: 2000,
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
                temperature: 0.3,
                maxOutputTokens: 2000
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
function downloadJobsAsCSV(jobs) {
    if (!jobs || !jobs.length) return;

    const headers = [
        "Title", "Company", "Locations", "Job Type", "Work Mode",
        "Experience Level", "Education Level", "Duration/Start time",
        "Salary and Benefits", "Visa Sponsorship", "Responsibility",
        "Required Skills", "Preferred Skills", "Description",
        "URL", "Source", "Scraped At"
    ];
    const csvRows = [];

    // Header row
    // Quote headers to be safe
    csvRows.push(headers.map(h => `"${h}"`).join(","));

    // Data rows
    for (const item of jobs) {
        if (!item || !item.job) continue; // Skip invalid items
        const jobData = item.job;
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
            jobData.scrapedAt || ""
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
