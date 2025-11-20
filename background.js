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
        // Inject scrape function into the current tab
        const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrapeJobFromPage
        });

        const job = injectionResult && injectionResult.result;
        if (!job) {
            console.log("No job found on the page.");
            return;
        }

        // Fallbacks in case fields are missing
        if (!job.title) job.title = "(Untitled job)";
        if (!job.company) job.company = "";
        if (!job.location) job.location = "";

        console.log("Scraped job:", job);

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

    const JobDetails = document.querySelector(".ccb-job-details");
    if (JobDetails) {
        const title = getText(JobDetails.querySelector("h1"));

        // department / team + broad area (e.g. "Backend, Engineering")
        const departmentEl = JobDetails.querySelector(".css-eBnvrI");
        const department = getText(departmentEl);

        // locations (multiple cities separated into .css-ghtRay)
        const locationEls = JobDetails.querySelectorAll(".css-ghtRay");
        const locations = Array.from(locationEls)
            .map((el) => getText(el).replace(/\s+\|\s*$/, "")) // strip trailing " |"
            .filter((txt) => txt.length > 0)
            .join(" | ");

        // description: we grab all <p> under .css-cvJeNJ (the main body area)
        let description = "";
        const descContainer =
            document.querySelector(".css-cvJeNJ") ||
            uberJobDetails.parentElement;
        if (descContainer) {
            const ps = descContainer.querySelectorAll("p");
            description = Array.from(ps)
                .map((p) => p.textContent.trim())
                .filter((txt) => txt.length > 0)
                .join("\n\n");
        }

        const job = {
            source: window.location.hostname,
            url: window.location.href,
            title: title,
            company: "",
            department: department,
            locations: locations,
            description: description
        };

        return { found: true, job: job };
    }
    // ========== END OF UBER-SPECIFIC LOGIC ==========


    // =========================================================
    // === EDIT HERE: GENERIC / OTHER-SITE FALLBACKS         ===
    // =========================================================
    // You can add additional blocks like the Uber one above,
    // checking for other patterns, e.g. LinkedIn, Greenhouse, etc.
    //
    // Example sketch for a generic page using <article>:
    
    const article = document.querySelector("article");
    if (article) {
        const title = getText(article.querySelector("h1, h2"));
        const company = getText(
            article.querySelector("[data-company-name], .company, .job-company")
        );
        const location = getText(
            article.querySelector("[data-location], .location, .job-location")
        );
        const description = getText(article);
    
        if (title) {
            return {
                found: true,
                job: {
                    source: window.location.hostname,
                    url: window.location.href,
                    title: title,
                    company: company,
                    locations: location,
                    description: description
                }
            };
        }
    }

    // If nothing matched:
    return { found: false };
}

// Function to build CSV string from jobs and download as job_listings.csv
function downloadJobsAsCSV(jobs) {
    if (!jobs || !jobs.length) return;

    const headers = ["Title", "Company", "Locations", "Description", "URL", "Source", "Department", "Scraped At"];
    const csvRows = [];

    // Header row
    csvRows.push(headers.join(","));

    // Data rows
    for (const item of jobs) {
        const jobData = item.job;
        const row = [
            jobData.title || "",
            jobData.company || "",
            jobData.locations || "",
            jobData.description || "",
            jobData.url || "",
            jobData.source || "",
            jobData.department || "",
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