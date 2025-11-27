// Clear badge text when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({
        text: ""
    });
});

// Click the extension to scrape current page
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;

    try {
        const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrapeJobFromPage
        });

        const job = injectionResult.result;
        if (!job || !job.found) {
            console.log("No job found on the page.");
            return;
        }

        // Fallbacks in case fields are missing
        // (Removed as not needed with proper checking)

        console.log("Scraped job:", job.job);
        if (job.debug) {
            console.log("Scrape debug:", job.debug);
        }

        // Add scraped timestamp
        job.job.scrapedAt = new Date().toISOString();

        // Save the job to local storage
        chrome.storage.local.get({ jobs: [] }, (data) => {
            const jobs = data.jobs;
            jobs.push(job);
            
            chrome.storage.local.set({ jobs }, () => {
                console.log("Job saved. Total jobs:", jobs.length);

                // Show count of saved jobs on the badge
                chrome.action.setBadgeText({
                    tabId: tab.id,
                    text: String(jobs.length),
                });

                // Generate/Download CSV everytime 
                downloadJobsAsCSV(jobs);
            });
        });
    } catch (error) {
        console.error("Error scraping job:", error);
    }
});

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

    // ===================================================================
    // PLATFORM-SPECIFIC SCRAPERS - Check these first before generic tiers
    // ===================================================================

    // LinkedIn specific scraper
    if (window.location.hostname.includes('linkedin.com')) {
        debug.source = 'linkedin-specific';
        debug.tiers.push('platform-specific');

        let title = '';
        let company = '';
        let locations = '';
        let description = '';

        // Title: h1.t-24.t-bold.inline > a
        const titleAnchor = document.querySelector('h1.t-24.t-bold.inline a');
        if (titleAnchor) {
            title = titleAnchor.textContent.trim();
            debug.selectors.title = 'linkedin:h1.t-24.t-bold.inline a';
        } else {
            const h1 = document.querySelector('h1.t-24.t-bold.inline');
            if (h1) {
                title = h1.textContent.trim();
                debug.selectors.title = 'linkedin:h1.t-24.t-bold.inline';
            }
        }

        // Company: anchor with data-test-app-aware-link or similar
        const companyEl = document.querySelector('a[data-test-app-aware-link], a[href*="/company/"]');
        if (companyEl) {
            company = companyEl.textContent.trim();
            debug.selectors.company = 'linkedin:a[data-test-app-aware-link]';
        }

        // Location: span.tvm__text--low-emphasis
        const locationEl = document.querySelector('span.tvm__text.tvm__text--low-emphasis');
        if (locationEl) {
            locations = locationEl.textContent.trim();
            debug.selectors.locations = 'linkedin:span.tvm__text--low-emphasis';
        }

        // Description: common containers
        const descContainers = [
            'div.jobs-description__content',
            'div.jobs-description__container',
            'section.jobs-description',
            'div[data-test-description]',
            'div[class*="jobs-description"]',
            'p[dir="ltr"]'
        ];
        for (const sel of descContainers) {
            const el = document.querySelector(sel);
            if (el) {
                const clone = el.cloneNode(true);
                clone.querySelectorAll('script, style, button').forEach(n => n.remove());
                description = clone.innerText.trim();
                debug.selectors.description = `linkedin:${sel}`;
                break;
            }
        }

        if (title || description) {
            return {
                found: true,
                job: {
                    source: window.location.hostname,
                    url: window.location.href,
                    title,
                    company,
                    locations,
                    description
                },
                debug
            };
        }
    }

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
        return {
            found: true,
            job: jobData,
            debug
        };
    }

    // If nothing matched:
    return { found: false };
}

// Function to build CSV string from jobs and download as job_listings.csv
function downloadJobsAsCSV(jobs) {
    if (!jobs || !jobs.length) return;

    const headers = ["Title", "Company", "Locations", "Description", "URL", "Source", "Scraped At"];
    const csvRows = [];

    // Header row
    csvRows.push(headers.join(","));

    // Data rows
    for (const item of jobs) {
        if (!item || !item.job) continue; // Skip invalid items
        const jobData = item.job;
        const row = [
            jobData.title || "",
            jobData.company || "",
            jobData.locations || "",
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

    const csvContent = csvRows.join("\n");
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent(csvContent);

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