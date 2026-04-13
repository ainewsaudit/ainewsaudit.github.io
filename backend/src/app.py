import os
import json
import base64
import datetime
from decimal import Decimal
from collections import defaultdict

import boto3
from boto3.dynamodb.conditions import Key, Attr

dynamodb = boto3.resource("dynamodb")
TABLE_NAME = os.environ.get("TABLE_NAME", "ai-news-articles")
table = dynamodb.Table(TABLE_NAME)

# Static counts — keep in sync with dataset_counts.json.
# These are returned instantly for pagination totals without a DynamoDB scan.
DATASET_COUNTS = {
    "recent_news": 186512,
    "opinions": 44803,
    "reporters": 20131,
}

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def json_response(status, body):
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def decode_cursor(cursor_str):
    if not cursor_str:
        return None
    try:
        return json.loads(base64.b64decode(cursor_str.encode()).decode())
    except Exception:
        return None


def encode_cursor(last_key):
    if not last_key:
        return None
    return base64.b64encode(
        json.dumps(last_key, cls=DecimalEncoder).encode()
    ).decode()


def build_filter_expression(params):
    """Build a DynamoDB FilterExpression from request query params."""
    filters = []

    # Prediction filter (comma-separated list, OR logic)
    prediction = (params.get("prediction") or "").strip()
    if prediction:
        preds = [p.strip() for p in prediction.split(",") if p.strip()]
        if preds:
            expr = None
            for p in preds:
                f = Attr("final_prediction").eq(p) | Attr("prediction").eq(p)
                expr = f if expr is None else (expr | f)
            if expr is not None:
                filters.append(expr)

    topic = (params.get("topic") or "").strip()
    if topic:
        filters.append(Attr("primary_topic").eq(topic))

    author = (params.get("author") or "").strip()
    if author:
        filters.append(Attr("authors").contains(author))

    newspaper = (params.get("newspaper") or "").strip()
    if newspaper:
        filters.append(
            Attr("newspaper").contains(newspaper)
            | Attr("publisher").contains(newspaper)
        )

    ai_min = params.get("ai_min")
    if ai_min is not None:
        filters.append(Attr("ai_likelihood").gte(Decimal(str(ai_min))))

    ai_max = params.get("ai_max")
    if ai_max is not None:
        filters.append(Attr("ai_likelihood").lte(Decimal(str(ai_max))))

    max_ai_min = params.get("max_ai_min")
    if max_ai_min is not None:
        filters.append(Attr("max_ai_likelihood").gte(Decimal(str(max_ai_min))))

    max_ai_max = params.get("max_ai_max")
    if max_ai_max is not None:
        filters.append(Attr("max_ai_likelihood").lte(Decimal(str(max_ai_max))))

    if not filters:
        return None
    expr = filters[0]
    for f in filters[1:]:
        expr = expr & f
    return expr


def apply_text_search(items, search):
    """Client-side text search after DynamoDB returns results."""
    if not search:
        return items
    s = search.lower()
    return [
        item for item in items
        if s in (item.get("title") or "").lower()
        or s in (item.get("authors") or "").lower()
        or s in (item.get("newspaper") or "").lower()
        or s in (item.get("publisher") or "").lower()
        or s in (item.get("article_id") or "").lower()
    ]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def handler(event, context):
    path = event.get("rawPath") or event.get("path", "/")
    params = event.get("queryStringParameters") or {}

    if path == "/articles":
        return get_articles(params)
    elif path == "/article":
        return get_article(params)
    elif path == "/counts":
        return get_counts()
    elif path == "/filter-options":
        return get_filter_options(params)
    elif path == "/stats":
        return get_stats(params)
    else:
        return json_response(404, {"error": "Not found"})


# ---------------------------------------------------------------------------
# /articles
# ---------------------------------------------------------------------------

def get_articles(params):
    dataset_type = params.get("dataset_type", "recent_news")
    if dataset_type not in DATASET_COUNTS:
        return json_response(400, {"error": f"Unknown dataset_type: {dataset_type}"})

    limit = min(int(params.get("limit", "20")), 100)
    offset = int(params.get("offset", "0"))
    search = (params.get("search") or "").strip().lower()
    start_date = (params.get("start_date") or "").strip()
    end_date = (params.get("end_date") or "").strip()

    # Exclude future-dated articles by capping the sort key at tomorrow.
    # date_id format is "YYYY-MM-DD#..." so string comparison works correctly.
    tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()

    # Key condition — always on partition key; optionally narrow by sort key range
    key_cond = Key("dataset_type").eq(dataset_type)
    if start_date and end_date:
        key_cond = key_cond & Key("date_id").between(start_date, end_date)
    elif start_date and not end_date:
        key_cond = key_cond & Key("date_id").between(start_date, tomorrow)
    elif end_date:
        key_cond = key_cond & Key("date_id").lte(end_date)
    else:
        # Default: exclude anything dated in the future
        key_cond = key_cond & Key("date_id").lt(tomorrow)

    filter_expr = build_filter_expression(params)

    query_kwargs = {
        "KeyConditionExpression": key_cond,
        "ScanIndexForward": False,  # newest first
    }
    if filter_expr is not None:
        query_kwargs["FilterExpression"] = filter_expr

    # Choose how many items to read per DynamoDB call.
    # - Simple queries (no extra filters, first page): read just what we need — fast.
    # - Filtered/paginated queries: over-read because FilterExpression is applied
    #   after the Limit, so some reads won't survive the filter.
    has_extra_filters = filter_expr is not None or bool(search)
    if not has_extra_filters and offset == 0:
        batch_size = limit + 1   # minimal read for the common first-page case
    else:
        batch_size = 500

    # Cap how many raw DynamoDB items we'll scan for text-search queries so
    # we stay well within the 29s Lambda timeout.
    MAX_TEXT_SCAN = 3000

    collected = []
    last_key = None
    items_scanned = 0

    while len(collected) < offset + limit:
        batch_kwargs = {**query_kwargs, "Limit": batch_size}
        if last_key:
            batch_kwargs["ExclusiveStartKey"] = last_key

        response = table.query(**batch_kwargs)
        raw_items = response.get("Items", [])
        items_scanned += len(raw_items)
        items = apply_text_search(raw_items, search)
        collected.extend(items)
        last_key = response.get("LastEvaluatedKey")

        if not last_key:
            break  # exhausted the partition

        # Stop scanning early for text searches to avoid timeouts
        if search and items_scanned >= MAX_TEXT_SCAN:
            break

        # After the first batch, switch to larger reads to reduce round-trips
        batch_size = 500

    result = collected[offset : offset + limit]
    has_more = (len(collected) > offset + limit) or (last_key is not None)

    # Build a more accurate total count for filtered queries.
    # `collected` already has every match we've seen; if last_key is set we
    # continue scanning with Select='COUNT' (no item data transferred) up to
    # COUNT_AHEAD_CAP raw items.  Text-search counts are Python-side so we
    # skip the extra scan for those (already capped at MAX_TEXT_SCAN).
    total_found = len(collected)
    count_exact = not bool(last_key)

    if filter_expr is not None and not search and last_key:
        COUNT_AHEAD_CAP = 10000
        extra_scanned = 0
        count_key = last_key
        count_kwargs = {
            "KeyConditionExpression": key_cond,
            "FilterExpression": filter_expr,
            "Select": "COUNT",
        }
        while extra_scanned < COUNT_AHEAD_CAP and count_key:
            ck = {**count_kwargs, "Limit": 500, "ExclusiveStartKey": count_key}
            cr = table.query(**ck)
            total_found += cr.get("Count", 0)
            extra_scanned += cr.get("ScannedCount", 0)
            count_key = cr.get("LastEvaluatedKey")
            if not count_key:
                count_exact = True
                break
        last_key = count_key  # update so has_more reflects remaining pages

    has_more = (len(collected) > offset + limit) or (last_key is not None)

    return json_response(200, {
        "articles": result,
        "total": DATASET_COUNTS.get(dataset_type, 0),
        "count": len(result),
        "total_found": total_found,
        "count_exact": count_exact,
        "hasMore": has_more,
        "nextCursor": encode_cursor(last_key) if has_more else None,
    })


# ---------------------------------------------------------------------------
# /article
# ---------------------------------------------------------------------------

def get_article(params):
    dataset_type = params.get("dataset_type")
    date_id = params.get("date_id")

    if not dataset_type or not date_id:
        return json_response(400, {"error": "dataset_type and date_id are required"})

    result = table.get_item(Key={"dataset_type": dataset_type, "date_id": date_id})
    item = result.get("Item")
    if not item:
        return json_response(404, {"error": "Article not found"})

    return json_response(200, item)


# ---------------------------------------------------------------------------
# /counts
# ---------------------------------------------------------------------------

def get_counts():
    return json_response(200, {
        **DATASET_COUNTS,
        "total": sum(DATASET_COUNTS.values()),
        "last_updated": "2025-10-20-v7",
    })


# ---------------------------------------------------------------------------
# /filter-options
# ---------------------------------------------------------------------------

def get_filter_options(params):
    """Return unique topics and newspapers by sampling up to SCAN_LIMIT items.

    A full partition scan for 186k items would exceed the API Gateway timeout,
    so we stop once we have enough distinct values or reach the item cap.
    """
    dataset_type = params.get("dataset_type", "recent_news")
    SCAN_LIMIT = 5000   # items to read; enough to surface all common topics/newspapers
    BATCH = 500

    topics = set()
    newspapers = set()
    items_read = 0
    last_key = None

    query_kwargs = {
        "KeyConditionExpression": Key("dataset_type").eq(dataset_type),
        "ProjectionExpression": "primary_topic, newspaper, publisher",
        "Limit": BATCH,
    }

    while items_read < SCAN_LIMIT:
        kwargs = dict(query_kwargs)
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key

        response = table.query(**kwargs)
        for item in response.get("Items", []):
            if item.get("primary_topic"):
                topics.add(item["primary_topic"])
            for field in ("newspaper", "publisher"):
                if item.get(field):
                    newspapers.add(item[field])

        items_read += len(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break

    return json_response(200, {
        "topics": sorted(topics),
        "newspapers": sorted(newspapers),
        "predictions": ["Human", "Mixed", "AI"],
        "datasets": ["recent_news", "opinions", "reporters"],
    })


# ---------------------------------------------------------------------------
# /stats
# ---------------------------------------------------------------------------

def get_stats(params):
    """Aggregate stats for dataset.html charts by scanning a full partition.

    Uses a ProjectionExpression so only small fields are transferred.
    For recent_news the time-series window matches the static loader (Jun–Sep 2025).
    """
    dataset_type = params.get("dataset_type", "recent_news")

    prediction_dist = defaultdict(int)
    time_series = defaultdict(lambda: {"total": 0, "ai_count": 0, "mixed_count": 0})
    topic_dist = defaultdict(int)
    newspaper_dist = defaultdict(int)

    # Date window for time-series (mirrors static-data-loader.js logic)
    time_start = "2025-06-01" if dataset_type == "recent_news" else None
    time_end = "2025-09-15" if dataset_type == "recent_news" else None

    query_kwargs = {
        "KeyConditionExpression": Key("dataset_type").eq(dataset_type),
        "ProjectionExpression":
            "prediction, final_prediction, publish_date, primary_topic, newspaper",
    }

    last_key = None
    while True:
        kwargs = dict(query_kwargs)
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key

        response = table.query(**kwargs)
        for item in response.get("Items", []):
            pred = item.get("final_prediction") or item.get("prediction") or ""
            if pred and "error" not in pred.lower():
                prediction_dist[pred] += 1

            pub_date = item.get("publish_date") or ""
            if pub_date:
                in_range = True
                if time_start and pub_date < time_start:
                    in_range = False
                if time_end and pub_date > time_end:
                    in_range = False
                if in_range:
                    month = pub_date[:7]  # YYYY-MM
                    time_series[month]["total"] += 1
                    if pred == "AI":
                        time_series[month]["ai_count"] += 1
                    elif pred == "Mixed":
                        time_series[month]["mixed_count"] += 1

            if item.get("primary_topic"):
                topic_dist[item["primary_topic"]] += 1

            if dataset_type == "opinions" and item.get("newspaper"):
                newspaper_dist[item["newspaper"]] += 1

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break

    return json_response(200, {
        "prediction_distribution": [
            {"prediction": k, "count": v}
            for k, v in sorted(prediction_dist.items(), key=lambda x: -x[1])
        ],
        "time_series": [
            {"month": k, **v}
            for k, v in sorted(time_series.items())
        ],
        "topic_distribution": [
            {"primary_topic": k, "count": v}
            for k, v in sorted(topic_dist.items(), key=lambda x: -x[1])
            if k
        ][:20],
        "newspaper_distribution": (
            [
                {"newspaper": k, "count": v}
                for k, v in sorted(newspaper_dist.items(), key=lambda x: -x[1])
            ][:10]
            if dataset_type == "opinions"
            else []
        ),
    })
