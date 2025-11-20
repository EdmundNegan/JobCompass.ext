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
    function getText(el) {
        return el ? el.textContent.trim() : "";
    }

    // General selectors for job postings
    const titleSelectors = [
        'h1',
         '.job-title', '.jobTitle', 'job_title', '[data-job-title]', '[data-qa="job-title"]',
         'h1.title', '.title', '.position-title',
          '.job-name', '[itemprop="title"]', '.posting-title'];
    let title = '';
    for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            title = getText(el);
            if (title) break;
        }
    }

    const companySelectors = ['.company', '.job-company', 
        '.jobCompany','[data-company]',
         '.employer', '.organization', '.company-name', '.employer-name'];
    let company = '';
    for (const sel of companySelectors) {
        const el = document.querySelector(sel);
        if (el) {
            company = getText(el);
            if (company) break;
        }
    }

    const locationSelectors = ['.location', '.job-location', '.jobLocation',
    '[data-location]', '[data-qa="location"]',
    '.city', '.place', '.job-place', 
    '.address', '.job-address',
    '[itemprop="jobLocation"]',
    '.location-text'];
    let locations = '';
    for (const sel of locationSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            locations = getText(el);
            if (locations) break;
        }
    }

    const descriptionSelectors = ['[class*="description"]',
    '[id*="description"]',
    '.job-description', '.jobDescription',
    '[data-description]', 
    '.details', '.job-details',
    '.content', '.job-content',
    'article', '.main-content',
    '[itemprop="description"]',
    '.show-more-less-html'];
    let description = '';
    for (const sel of descriptionSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            description = getText(el);
            if (description) break;
        }
    }

    // If we found at least a title or description, consider it a job page
    if (title || description) {
        return {
            found: true,
            job: {
                source: window.location.hostname,
                url: window.location.href,
                title: title,
                company: company,
                locations: locations,
                description: description,
            }
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