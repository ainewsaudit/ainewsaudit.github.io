(function () {
    function findBanners() {
        return Array.from(document.querySelectorAll('[role="status"]')).filter((element) =>
            element.textContent && element.textContent.includes('Active data update:')
        );
    }

    function setBannerMessage(banner, message) {
        if (!message) return;
        const strong = banner.querySelector('.font-semibold');
        if (!strong) return;
        const textNode = Array.from(strong.parentNode.childNodes).find(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
        );
        if (textNode) {
            textNode.textContent = ` ${message}`;
        }
    }

    async function syncActiveUpdateBanner() {
        const banners = findBanners();
        if (banners.length === 0) return;

        try {
            const response = await fetch('/additional_data/dataset_counts.json', { cache: 'no-cache' });
            if (!response.ok) return;
            const metadata = await response.json();
            const update = metadata.active_update || {};
            if (update.recent_news === false || update.status === 'complete') {
                banners.forEach((banner) => banner.remove());
                return;
            }
            banners.forEach((banner) => setBannerMessage(banner, update.message));
        } catch (error) {
            console.warn('Failed to sync active update banner:', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncActiveUpdateBanner, { once: true });
    } else {
        syncActiveUpdateBanner();
    }
})();
