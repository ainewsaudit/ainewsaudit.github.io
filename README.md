# AI News Audit

A static website that analyzes and tracks AI-generated content in 251,000+ news articles with advanced search and filtering capabilities.

## 🚀 Live Demo

Visit [https://ainewsaudit.github.io](https://ainewsaudit.github.io) (once deployed)

## 📊 Features

- **Advanced Search**: Search through 251,000+ articles by title, content, or author
- **Smart Filtering**: Filter by topic, dataset, AI prediction, date range, and likelihood scores
- **Dataset Analysis**: Interactive charts and statistics for each dataset
- **Article Details**: Comprehensive AI analysis for each article
- **Fully Static**: No backend required - runs entirely in your browser!

## 🏗️ Architecture

This is a **100% static website** that:
- Loads compressed JSON data files (71MB total) directly in the browser
- Uses client-side JavaScript for search and filtering
- Requires no backend server or database
- Can be hosted for free on GitHub Pages

### Data Structure

The site includes three datasets with truncated article text (first 20 words):

- **Recent News**: 186,512 articles (~54MB compressed)
- **Opinions**: 44,803 articles (~12MB compressed)
- **Reporters**: 20,154 articles (~4.8MB compressed)

Each article includes:
- Title, authors, publish date
- AI likelihood scores (average, max, fraction)
- Prediction (Human, AI, or Mixed)
- Primary topic classification
- Article preview (first 20 words)
- Original article URL

## 🚢 Deployment to GitHub Pages

### Step 1: Initialize Git Repository (if not already done)

```bash
cd /home/jrussell/ainewsaudit.github.io
git init
git add .
git commit -m "Initial commit: Static AI News Audit site"
```

### Step 2: Create GitHub Repository

1. Go to [GitHub](https://github.com) and create a new repository named `ainewsaudit.github.io`
2. **Important**: Do NOT initialize with README, .gitignore, or license (we already have these)

### Step 3: Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/ainewsaudit.github.io.git
git branch -M main
git push -u origin main
```

### Step 4: Enable GitHub Pages

1. Go to your repository settings
2. Navigate to "Pages" in the left sidebar
3. Under "Source", select "main" branch
4. Click "Save"

Your site will be live at `https://YOUR_USERNAME.github.io/ainewsaudit.github.io/` within a few minutes!

## 📂 File Structure

```
ainewsaudit.github.io/
├── index.html                 # Redirects to search.html
├── search.html               # Main search interface
├── article.html              # Individual article viewer
├── dataset.html              # Dataset analysis with charts
├── static-data-loader.js     # Client-side data loader
├── static_data/              # Compressed JSON data
│   ├── recent_news_data.json.gz    (54MB)
│   ├── opinions_data.json.gz       (12MB)
│   └── reporters_data.json.gz      (4.8MB)
└── README.md                 # This file
```

## 🔧 Technology Stack

- **HTML5/CSS3**: Modern, responsive design
- **TailwindCSS**: Utility-first CSS framework (via CDN)
- **JavaScript (ES6+)**: Client-side data processing
- **Pako.js**: Gzip decompression in the browser
- **Chart.js**: Interactive charts and visualizations

## 💻 Local Development

To test locally, you need a simple HTTP server (browsers block file:// protocol for security):

### Using Python:
```bash
cd /home/jrussell/ainewsaudit.github.io
python3 -m http.server 8000
```

Then visit `http://localhost:8000/search.html`

### Using Node.js:
```bash
npx http-server -p 8000
```

## 📈 Performance

- **Initial Load**: Downloads ~71MB of compressed data (decompresses to ~479MB in memory)
- **Search**: Instant client-side filtering through all articles
- **Caching**: Data is cached in memory after first load
- **Progressive Loading**: Each dataset loads independently

## 🔍 Search Capabilities

- **Text Search**: Search in titles, content, and authors
- **Topic Filter**: Filter by primary topic
- **Dataset Filter**: Filter by Recent News, Opinions, or Reporters
- **Date Range**: Filter by publication date
- **AI Likelihood**: Filter by AI detection scores
- **Prediction Filter**: Show only Human, AI, or Mixed content
- **Sorting**: Sort by date, AI likelihood, or title

## 📊 Dataset Analysis

Each dataset page includes:
- Total article count and statistics
- Prediction distribution (pie chart)
- Top topics (pie chart)
- AI/Mixed content trends over time (line chart)

## 🤝 Contributing

This is a static archive site. The data is pre-processed and cannot be updated through the interface.

## 📝 Data Source

Data files are located in `/home/jrussell/news_slop/final_data/` and have been:
- Truncated to first 20 words per article (for size reduction)
- Compressed with gzip
- Analyzed for AI-generated content using advanced detection algorithms

## 📄 License

MIT License - feel free to use and modify as needed.

## 🐛 Issues?

If you encounter any issues:
1. Check browser console for errors
2. Ensure you're using a modern browser (Chrome, Firefox, Safari, Edge)
3. Try clearing cache and reloading
4. Check that all data files loaded successfully

## 🎯 Future Enhancements

Possible improvements:
- Add more sophisticated text search (fuzzy matching)
- Implement virtual scrolling for better performance
- Add data visualization for individual articles
- Export search results to CSV
- Add bookmarking/favorites functionality
