# JobCompass — AI-Powered Job Search Assistant

A sophisticated Chrome extension that scrapes job listings, scores them using AI, and provides intelligent recommendations for job applications.

## Features

### 🔍 Job Scraping
- Automatically scrape job listings from any webpage
- Extract key information: title, company, location, salary, requirements, etc.
- Support for multiple job boards and career sites

### 🤖 AI-Powered Scoring
- **Desirability Scoring**: Evaluate jobs based on your preferences (location, role type, salary, etc.)
- **Eligibility Scoring**: Assess how well you match job requirements (experience, skills, education)
- **Overall Scoring**: Weighted combination of desirability and eligibility scores
- **Smart Recommendations**: Automatic "Apply" or "Don't Apply" decisions with detailed reasoning

### 📊 Advanced Analytics
- Configurable scoring weights (0-100% for desirability vs eligibility)
- Mandatory criteria enforcement (must-match requirements)
- Threshold-based filtering
- Detailed score breakdowns and explanations

### 📋 Data Management
- CSV export with comprehensive job data and scores
- Resume upload for auto-filling eligibility criteria
- Persistent settings and scoring configurations

### 🎯 Intelligent Filtering
- Set custom preferences for job categories
- Define your eligibility profile (experience, skills, education)
- Automatic job ranking and prioritization

## Quick Start

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd <repository-directory>
   ```

2. **Load in Chrome**
   - Open `chrome://extensions`
   - Enable "Developer mode" (top-right toggle)
   - Click "Load unpacked" and select the extension folder
   - Pin the extension to your toolbar

### Basic Usage

1. **Navigate to a job listing page**
2. **Click the JobCompass icon** to scrape the job
3. **Configure scoring** in the extension options
4. **Export results** to CSV for analysis

## Configuration

### LLM API Setup

The extension supports multiple AI providers for intelligent scoring:

1. **Open Options** (right-click extension icon → Options)
2. **Configure API Settings**:
   - Choose provider (OpenAI, Anthropic, or Gemini)
   - Enter your API key
   - Select model (GPT-4, Claude, Gemini, etc.)
3. **Set Scoring Preferences**:
   - Desirability criteria (what you want in a job)
   - Eligibility details (your qualifications)
   - Weight distribution (desirability vs eligibility balance)
   - Threshold for recommendations

### Scoring Configuration

#### Desirability Criteria
Define what makes a job appealing to you:
- **Role Category**: Data Scientist, Software Engineer, etc.
- **Locations**: Preferred work locations
- **Job Type**: Full-time, internship, remote, etc.
- **Work Mode**: Remote, hybrid, on-site
- **Experience Level**: Entry, mid, senior
- **Duration**: Permanent, contract, etc.
- **Salary & Benefits**: Minimum compensation expectations
- **Visa Sponsorship**: Required visa support
- **Custom Categories**: Add your own criteria

#### Eligibility Profile
Input your qualifications for matching:
- **Experience Level**: Years of experience
- **Education Level**: Degree requirements
- **Required Skills**: Must-have technical skills
- **Preferred Skills**: Nice-to-have skills

#### Weight & Threshold Settings
- **Score Weights**: Balance between desirability (70%) and eligibility (30%)
- **Application Threshold**: Minimum overall score for recommendations
- **Mandatory Criteria**: Requirements that must be met

### Resume Upload
- Upload TXT or PDF resumes to auto-populate eligibility criteria
- Automatic extraction of experience, education, and skills
- Manual editing of extracted information

## Usage Guide

### Scraping Jobs

1. **Find a job listing** on any website
2. **Click the JobCompass icon** in your toolbar
3. **Select "Scrape & Score"** to analyze the job
4. **View results** in the extension popup

### Scoring Jobs

1. **Access stored jobs** via the extension popup
2. **Configure scoring criteria** in options
3. **Run scoring** on individual jobs or all jobs
4. **Export to CSV** for detailed analysis

### CSV Export Features

The exported CSV includes:
- **Basic Job Info**: Title, company, location, salary, etc.
- **Individual Scores**: Desirability and eligibility scores with breakdowns
- **Overall Score**: Weighted combination score
- **Apply Decision**: Yes/No with detailed reasoning
- **Score Headers**: Dynamic headers showing current weight ratios

### Interpreting Results

- **Overall Score**: 0-100, higher is better
- **Apply Column**:
  - `Yes`: Meets threshold and all mandatory criteria
  - `No - Below threshold (X < Y)`: Score too low
  - `No - Does not meet mandatory requirement: [criteria]`: Fails required criteria

## Development

### Local Development

1. **Make code changes** to any `.js`, `.html`, or `.json` files
2. **Reload the extension**:
   - Go to `chrome://extensions`
   - Click "Reload" on the JobCompass extension
3. **Test changes** on job listing pages

### Debugging

- **Service Worker Logs**: Click "Service worker" in extension details
- **Content Script Logs**: Open DevTools on the target webpage
- **Console Output**: Check for scoring progress and API responses

### Architecture

- **manifest.json**: Extension configuration and permissions
- **background.js**: Core logic, scraping, and AI scoring
- **popup.js/popup.html**: Extension interface
- **options.js/options.html**: Settings and configuration
- **content.js**: Page interaction and data extraction

## API Requirements

### Supported Providers

- **OpenAI**: GPT-4, GPT-3.5-turbo
- **Anthropic**: Claude 3 models
- **Google Gemini**: Gemini 1.5, 2.0

### API Key Security

- Keys are stored locally in Chrome storage
- Never transmitted except to respective AI APIs
- No data logging or external tracking

## Troubleshooting

### Common Issues

- **"Load unpacked" fails**: Ensure selecting the correct folder with `manifest.json`
- **Extension not appearing**: Confirm enabled and pinned in toolbar
- **Scoring not working**: Check API key configuration and model selection
- **CSV export empty**: Ensure jobs are scraped and scored first

### Performance Tips

- Use appropriate model sizes (smaller models for faster scoring)
- Batch score multiple jobs for efficiency
- Clear old jobs periodically to maintain performance

## Contributing

1. **Fork the repository**
2. **Create a feature branch**
3. **Make your changes**
4. **Test thoroughly**
5. **Submit a pull request**

## License

See project files for license information.

---

**JobCompass** - Making job searching smarter with AI-powered insights.