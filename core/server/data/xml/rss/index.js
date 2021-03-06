var crypto      = require('crypto'),
    downsize    = require('downsize'),
    RSS         = require('rss'),
    url         = require('url'),
    utils       = require('../../../utils'),
    errors      = require('../../../errors'),
    i18n        = require('../../../i18n'),
    filters     = require('../../../filters'),
    processUrls = require('../../../utils/make-absolute-urls'),
    settingsCache = require('../../../settings/cache'),

    // Really ugly temporary hack for location of things
    fetchData   = require('../../../controllers/frontend/fetch-data'),

    generate,
    generateFeed,
    generateTags,
    getFeedXml,
    feedCache = {};

function handleError(next) {
    return function handleError(err) {
        return next(err);
    };
}

function getData(channelOpts, slugParam) {
    channelOpts.data = channelOpts.data || {};

    return fetchData(channelOpts, slugParam).then(function (result) {
        var response = {},
            titleStart = '';

        if (result.data && result.data.tag) { titleStart = result.data.tag[0].name + ' - ' || ''; }
        if (result.data && result.data.author) { titleStart = result.data.author[0].name + ' - ' || ''; }

        response.title = titleStart + settingsCache.get('title');
        response.description = settingsCache.get('description');
        response.results = {
            posts: result.posts,
            meta: result.meta
        };

        return response;
    });
}

getFeedXml = function getFeedXml(path, data) {
    var dataHash = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
    if (!feedCache[path] || feedCache[path].hash !== dataHash) {
        // We need to regenerate
        feedCache[path] = {
            hash: dataHash,
            xml: generateFeed(data)
        };
    }

    return feedCache[path].xml;
};

generateTags = function generateTags(data) {
    if (data.tags) {
        return data.tags.reduce(function (tags, tag) {
            if (tag.visibility !== 'internal') {
                tags.push(tag.name);
            }
            return tags;
        }, []);
    }

    return [];
};

generateFeed = function generateFeed(data) {
    var feed = new RSS({
        title: data.title,
        description: data.description,
        generator: 'Ghost ' + data.version,
        feed_url: data.feedUrl,
        site_url: data.siteUrl,
        image_url: utils.url.urlFor({relativeUrl: 'favicon.png'}, true),
        ttl: '60',
        custom_namespaces: {
            content: 'http://purl.org/rss/1.0/modules/content/',
            media: 'http://search.yahoo.com/mrss/'
        }
    });

    data.results.posts.forEach(function forEach(post) {
        var itemUrl = utils.url.urlFor('post', {post: post, secure: data.secure}, true),
            htmlContent = processUrls(post.html, data.siteUrl, itemUrl),
            item = {
                title: post.title,
                description: post.custom_excerpt || post.meta_description || downsize(htmlContent.html(), {words: 50}),
                guid: post.id,
                url: itemUrl,
                date: post.published_at,
                categories: generateTags(post),
                author: post.author ? post.author.name : null,
                custom_elements: []
            },
            imageUrl;

        if (post.feature_image) {
            imageUrl = utils.url.urlFor('image', {image: post.feature_image, secure: data.secure}, true);

            // Add a media content tag
            item.custom_elements.push({
                'media:content': {
                    _attr: {
                        url: imageUrl,
                        medium: 'image'
                    }
                }
            });

            // Also add the image to the content, because not all readers support media:content
            htmlContent('p').first().before('<img src="' + imageUrl + '" />');
            htmlContent('img').attr('alt', post.title);
        }

        item.custom_elements.push({
            'content:encoded': {
                _cdata: htmlContent.html()
            }
        });

        filters.doFilter('rss.item', item, post).then(function then(item) {
            feed.item(item);
        });
    });

    return filters.doFilter('rss.feed', feed).then(function then(feed) {
        return feed.xml();
    });
};

generate = function generate(req, res, next) {
    // Initialize RSS
    var pageParam = req.params.page !== undefined ? req.params.page : 1,
        slugParam = req.params.slug,
        // Base URL needs to be the URL for the feed without pagination:
        baseUrl = url.parse(req.originalUrl).pathname.replace(new RegExp('/' + pageParam + '/$'), '/'),
        channelConfig = res.locals.channel;

    // Ensure we at least have an empty object for postOptions
    channelConfig.postOptions = channelConfig.postOptions || {};
    // Set page on postOptions for the query made later
    channelConfig.postOptions.page = pageParam;

    channelConfig.slugParam = slugParam;

    return getData(channelConfig).then(function then(data) {
        var maxPage = data.results.meta.pagination.pages;

        // If page is greater than number of pages we have, redirect to last page
        if (pageParam > maxPage) {
            return next(new errors.NotFoundError({message: i18n.t('errors.errors.pageNotFound')}));
        }

        data.version = res.locals.safeVersion;
        data.siteUrl = utils.url.urlFor('home', {secure: req.secure}, true);
        data.feedUrl = utils.url.urlFor({relativeUrl: baseUrl, secure: req.secure}, true);
        data.secure = req.secure;

        return getFeedXml(baseUrl, data).then(function then(feedXml) {
            res.set('Content-Type', 'text/xml; charset=UTF-8');
            res.send(feedXml);
        });
    }).catch(handleError(next));
};

module.exports = generate;
