#!/usr/bin/env python3
"""
Build the static artifacts the website consumes, so no page ever has to download
and parse the full multi-hundred-MB article payload (which crashes mobile Safari).

For each dataset (recent_news, opinions, reporters) we emit:

  data/stats/<dataset>_stats.json
      Precomputed aggregate stats — exactly the object the loader's
      getDatasetStats() returns. Powers dataset.html / author.html with a tiny
      download instead of crunching 377k rows client-side.

  data/index/<dataset>_index.ndjson.gz
      The browse index (one COMPLETE record per line, gzipped). It powers
      browse/search, filtered stats, AND the article page — everything is small
      because the public `text` field is only the first 20 words. The source link
      is coalesced onto `url` (article_id is identical where both exist), then the
      duplicate `article_id` and the constant `dataset_type` are dropped.
      Streamed + decompressed incrementally on the client so peak memory stays low.

`id` is assigned exactly as the loader did (prefix * 1_000_000 + row index) so
ids stay stable across pages.

Usage:  python3 build_static_data.py [--datasets recent_news opinions reporters]
"""

import argparse
import gzip
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

DATASET_PREFIX = {"recent_news": 1, "opinions": 2, "reporters": 3}

# The browse index carries the COMPLETE record — everything is small, because the
# public `text` field is only the first 20 words of each article. We drop just
# `article_id` (coalesced onto `url` above) and `dataset_type` (constant per
# file; the loader stamps it on load).
INDEX_DROP_FIELDS = {"article_id", "dataset_type"}

# HARD CAP: never publish more than the first N words of article text, anywhere.
# The source is already truncated to 20 words; this is a defensive guarantee so a
# future source change can never leak full text into the website/HF artifacts.
TEXT_WORD_LIMIT = 20

BIN_COUNT = 20
CURATED_OWNERS = [
    'New York Times Company', 'Dow Jones & Company (News Corp)', 'Nash Holdings (Jeff Bezos)',
    'Gannett/Gatehouse', 'Alden/MediaNews Group', 'Advance Publications', 'Hearst Communications',
    'Lee Enterprises', 'Adams Publishing Group', 'Paxton Media Group', 'Boone Newsmedia',
    'Carpenter Media Group', 'CNHI', 'CherryRoad Media', 'Community Media Group',
    'Ogden Newspapers', 'Horizon Publications', 'Forum Communications',
]


def to_num(val):
    if val is None:
        return None
    try:
        n = float(val)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def first_words(text, n):
    if not text:
        return text
    return " ".join(str(text).split()[:n])


def label_of(a):
    # Mirrors the loader: final_prediction is absent, normalizePrediction is a
    # no-op, so the resolved label is just `prediction`.
    return a.get("final_prediction") or a.get("prediction") or ""


def month_of(publish_date):
    # publish_date is an ISO-ish string; slice for a deterministic YYYY-MM.
    return str(publish_date)[:7] if publish_date else None


def big3_group(name):
    n = (name or "").lower()
    if n.startswith("the "):
        n = n[4:]
    n = n.strip()
    if "new york times" in n or "washington post" in n or "wall street journal" in n:
        return "Big 3"
    return "Local papers"


def parse_dt(s):
    if not s:
        return None
    try:
        # Handle trailing Z and space-separated forms.
        s = str(s).replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except ValueError:
        try:
            return datetime.strptime(str(s)[:10], "%Y-%m-%d")
        except ValueError:
            return None


def compute_stats(articles, dataset_type, now):
    valid = [a for a in articles if "error" not in str(a.get("prediction", "")).lower()]

    # Prediction distribution
    pred_dist = defaultdict(int)
    for a in valid:
        lbl = a.get("prediction")
        if lbl:
            pred_dist[lbl] += 1

    # Time window (recent_news clipped to collection window)
    articles_for_time = valid
    if dataset_type == "recent_news":
        start = datetime(2025, 6, 1)
        end = now.replace(hour=23, minute=59, second=59, microsecond=999000)
        kept = []
        for a in valid:
            d = parse_dt(a.get("publish_date"))
            if d is None:
                continue
            # compare naive
            dn = d.replace(tzinfo=None)
            if start <= dn <= end:
                kept.append(a)
        articles_for_time = kept

    # Monthly time series
    ts = {}
    for a in articles_for_time:
        m = month_of(a.get("publish_date"))
        if not m:
            continue
        row = ts.setdefault(m, {"month": m, "total": 0, "ai_count": 0, "mixed_count": 0})
        row["total"] += 1
        lbl = label_of(a)
        if lbl == "AI":
            row["ai_count"] += 1
        elif lbl == "Mixed":
            row["mixed_count"] += 1

    # Per-publisher monthly (opinions)
    ts_pub = {}
    if dataset_type == "opinions":
        for a in articles_for_time:
            m = month_of(a.get("publish_date"))
            if not m:
                continue
            pub = a.get("newspaper") or a.get("newspaper_name") or "Unknown"
            key = f"{pub}||{m}"
            row = ts_pub.setdefault(key, {"month": m, "publisher": pub, "total": 0, "ai_count": 0, "mixed_count": 0})
            row["total"] += 1
            lbl = label_of(a)
            if lbl == "AI":
                row["ai_count"] += 1
            elif lbl == "Mixed":
                row["mixed_count"] += 1

    # Per-group monthly (recent_news: Big 3 vs local)
    ts_grp = {}
    if dataset_type == "recent_news":
        for a in articles_for_time:
            m = month_of(a.get("publish_date"))
            if not m:
                continue
            grp = big3_group(a.get("newspaper") or a.get("newspaper_name"))
            key = f"{grp}||{m}"
            row = ts_grp.setdefault(key, {"month": m, "group": grp, "total": 0, "ai_count": 0, "mixed_count": 0})
            row["total"] += 1
            lbl = label_of(a)
            if lbl == "AI":
                row["ai_count"] += 1
            elif lbl == "Mixed":
                row["mixed_count"] += 1

    # Last-30-day proportional AI use (recent_news)
    last30 = None
    if dataset_type == "recent_news":
        CUTOFF = "2025-09"
        base = {"Big 3": 0, "Local papers": 0}
        for row in ts_grp.values():
            if row["month"] < CUTOFF:
                base[row["group"]] += row["total"]
        base_sum = base["Big 3"] + base["Local papers"]
        max_ts = None
        for a in articles_for_time:
            d = parse_dt(a.get("publish_date"))
            if d is None:
                continue
            dn = d.replace(tzinfo=None)
            if max_ts is None or dn > max_ts:
                max_ts = dn
        if max_ts is not None:
            window_start = max_ts - timedelta(days=30)
            grp = {"Big 3": {"t": 0, "f": 0}, "Local papers": {"t": 0, "f": 0}}
            raw_t = raw_f = 0
            for a in articles_for_time:
                d = parse_dt(a.get("publish_date"))
                if d is None:
                    continue
                dn = d.replace(tzinfo=None)
                if not (window_start <= dn <= max_ts):
                    continue
                g = grp[big3_group(a.get("newspaper") or a.get("newspaper_name"))]
                lbl = label_of(a)
                flagged = 1 if lbl in ("AI", "Mixed") else 0
                g["t"] += 1
                g["f"] += flagged
                raw_t += 1
                raw_f += flagged
            num = wsum = 0.0
            if base_sum:
                for k in ("Big 3", "Local papers"):
                    w = base[k] / base_sum
                    if grp[k]["t"] > 0:
                        num += w * (grp[k]["f"] / grp[k]["t"])
                        wsum += w
            last30 = {
                "start": window_start.strftime("%Y-%m-%d"),
                "end": max_ts.strftime("%Y-%m-%d"),
                "total": raw_t,
                "raw_pct": round(100 * raw_f / raw_t, 2) if raw_t else None,
                "proportional_pct": round(100 * num / wsum, 2) if wsum else None,
                "big3_pct": round(100 * grp["Big 3"]["f"] / grp["Big 3"]["t"], 2) if grp["Big 3"]["t"] else None,
                "local_pct": round(100 * grp["Local papers"]["f"] / grp["Local papers"]["t"], 2) if grp["Local papers"]["t"] else None,
            }

    # Topic distribution w/ prediction breakdown
    topic_dist = {}
    for a in valid:
        t = a.get("primary_topic")
        if not t:
            continue
        row = topic_dist.setdefault(t, {"primary_topic": t, "count": 0, "human": 0, "mixed": 0, "ai": 0})
        row["count"] += 1
        lbl = label_of(a)
        if lbl == "AI":
            row["ai"] += 1
        elif lbl == "Mixed":
            row["mixed"] += 1
        elif lbl == "Human":
            row["human"] += 1

    # Newspaper distribution
    np_dist = {}
    for a in valid:
        np = (a.get("newspaper") or a.get("newspaper_name") or "Unknown").strip()
        if not np:
            continue
        row = np_dist.setdefault(np, {"newspaper": np, "count": 0, "human": 0, "mixed": 0, "ai": 0})
        row["count"] += 1
        lbl = label_of(a)
        if lbl == "AI":
            row["ai"] += 1
        elif lbl == "Mixed":
            row["mixed"] += 1
        elif lbl == "Human":
            row["human"] += 1

    # Owner distribution
    owner_dist = {}
    for a in valid:
        owner = (a.get("news_deserts_owner_name") or "").strip()
        if not owner or owner == "Unknown":
            continue
        row = owner_dist.setdefault(owner, {"owner": owner, "count": 0, "human": 0, "mixed": 0, "ai": 0})
        row["count"] += 1
        lbl = label_of(a)
        if lbl == "AI":
            row["ai"] += 1
        elif lbl == "Mixed":
            row["mixed"] += 1
        elif lbl == "Human":
            row["human"] += 1

    # Owner x topic matrix
    owner_topic = defaultdict(lambda: defaultdict(lambda: {"total": 0, "flagged": 0}))
    for a in valid:
        owner = (a.get("news_deserts_owner_name") or "").strip()
        topic = (a.get("primary_topic") or "").strip()
        if not owner or owner == "Unknown" or not topic or topic in ("Other", "Unknown"):
            continue
        cell = owner_topic[owner][topic]
        cell["total"] += 1
        if label_of(a) in ("AI", "Mixed"):
            cell["flagged"] += 1

    # Per-author monthly trend
    author_agg = {}
    for a in valid:
        alias = (a.get("author_alias") or "").strip()
        pd = a.get("publish_date")
        if not alias or not pd:
            continue
        day = str(pd)[:10]
        m = day[:7]
        o = author_agg.get(alias)
        if o is None:
            o = author_agg[alias] = {"alias": alias, "total": 0, "flagged": 0, "months": {}, "papers": {}, "start": day, "end": day}
        o["total"] += 1
        lbl = label_of(a)
        fl = 1 if lbl in ("AI", "Mixed") else 0
        o["flagged"] += fl
        mm = o["months"].setdefault(m, [0, 0])
        mm[0] += 1
        mm[1] += fl
        np = (a.get("newspaper") or "").strip()
        if np and np != "Unknown":
            o["papers"][np] = o["papers"].get(np, 0) + 1
        if day < o["start"]:
            o["start"] = day
        if day > o["end"]:
            o["end"] = day
    for o in author_agg.values():
        top, n = None, 0
        for p, c in o["papers"].items():
            if c > n:
                top, n = p, c
        o["top_paper"] = top
        o["top_paper_n"] = n
        del o["papers"]

    # AI-likelihood histogram
    like_hist = [0] * BIN_COUNT
    for a in valid:
        v = to_num(a.get("ai_likelihood"))
        if v is None:
            continue
        b = int(v * BIN_COUNT)
        b = max(0, min(BIN_COUNT - 1, b))
        like_hist[b] += 1

    # Fraction-of-AI histogram (flagged only)
    frac_hist = [0] * BIN_COUNT
    flagged_with_fraction = 0
    for a in valid:
        if label_of(a) not in ("AI", "Mixed"):
            continue
        v = to_num(a.get("fraction_ai_content"))
        if v is None:
            continue
        b = int(v * BIN_COUNT)
        b = max(0, min(BIN_COUNT - 1, b))
        frac_hist[b] += 1
        flagged_with_fraction += 1

    # Owner x topic matrix payload (curated + top-by-volume owners)
    by_volume = [o["owner"] for o in sorted(owner_dist.values(), key=lambda x: -x["count"])]
    owner_set = list(dict.fromkeys([o for o in CURATED_OWNERS if o in owner_dist] + by_volume[:20]))
    matrix_topics = [
        t["primary_topic"] for t in sorted(
            (t for t in topic_dist.values() if t["primary_topic"] and t["primary_topic"] not in ("Other", "Unknown")),
            key=lambda t: -((t["ai"] + t["mixed"]) / t["count"]) if t["count"] else 0,
        )
    ]
    owner_topic_matrix = {
        "owners": owner_set,
        "topics": matrix_topics,
        "owner_totals": [
            {"owner": o, "count": owner_dist.get(o, {}).get("count", 0),
             "flagged": owner_dist.get(o, {}).get("ai", 0) + owner_dist.get(o, {}).get("mixed", 0)}
            for o in owner_set
        ],
        "cells": [
            [
                ({"total": owner_topic[o][t]["total"], "flagged": owner_topic[o][t]["flagged"]}
                 if t in owner_topic.get(o, {}) else {"total": 0, "flagged": 0})
                for t in matrix_topics
            ]
            for o in owner_set
        ],
    }

    return {
        "dataset_type": dataset_type,
        "prediction_distribution": sorted(
            ({"prediction": k, "count": v} for k, v in pred_dist.items()),
            key=lambda x: -x["count"]),
        "time_series": sorted(ts.values(), key=lambda x: x["month"]),
        "time_series_by_publisher": sorted(ts_pub.values(), key=lambda x: x["month"]),
        "time_series_by_group": sorted(ts_grp.values(), key=lambda x: x["month"]),
        "last_30_days": last30,
        "author_trends": sorted(
            (o for o in author_agg.values() if o["total"] >= (5 if dataset_type == "opinions" else 20)),
            key=lambda x: -x["total"]),
        "topic_distribution": sorted(topic_dist.values(), key=lambda x: -x["count"])[:15],
        "newspaper_distribution": sorted(np_dist.values(), key=lambda x: -x["count"])[:20],
        "owner_distribution": sorted(owner_dist.values(), key=lambda x: -x["count"])[:20],
        "owner_topic_matrix": owner_topic_matrix,
        "likelihood_histogram": like_hist,
        "fraction_histogram": frac_hist,
        "flagged_count": flagged_with_fraction,
        "bin_count": BIN_COUNT,
    }


def build_dataset(dataset_type, now):
    src = os.path.join(DATA_DIR, f"{dataset_type}_data.json.gz")
    if not os.path.exists(src):
        print(f"  ! source missing, skipping: {src}")
        return None

    print(f"[{dataset_type}] loading {src} ...")
    with gzip.open(src) as f:
        articles = json.load(f)
    prefix = DATASET_PREFIX[dataset_type]

    # Assign ids exactly as the loader did, and numeric-normalize the score fields.
    for i, a in enumerate(articles):
        a["dataset_type"] = dataset_type
        a["id"] = prefix * 1_000_000 + i
        # Normalize the source link onto a single `url` field. recent_news carries
        # both `url` and `article_id` (identical); opinions/reporters carry only
        # `article_id`. Coalescing here lets us drop `article_id` from the index
        # without losing the link for the ProQuest-sourced datasets.
        if not a.get("url") and a.get("article_id"):
            a["url"] = a["article_id"]
        for k in ("ai_likelihood", "avg_ai_likelihood", "max_ai_likelihood", "fraction_ai_content"):
            if k in a:
                a[k] = to_num(a[k])
    print(f"[{dataset_type}] {len(articles):,} articles")

    os.makedirs(os.path.join(DATA_DIR, "stats"), exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "index"), exist_ok=True)

    # --- stats ---
    stats = compute_stats(articles, dataset_type, now)
    stats_path = os.path.join(DATA_DIR, "stats", f"{dataset_type}_stats.json")
    with open(stats_path, "w") as f:
        json.dump(stats, f, separators=(",", ":"))
    print(f"[{dataset_type}] wrote {stats_path} ({os.path.getsize(stats_path)/1024:.0f} KB)")

    # --- browse index (gzipped NDJSON, one complete record per line) ---
    # This single file powers browse/search, filtered stats, and the article page.
    index_path = os.path.join(DATA_DIR, "index", f"{dataset_type}_index.ndjson.gz")
    valid_count = 0
    max_words = 0
    with gzip.open(index_path, "wt", encoding="utf-8") as f:
        for a in articles:
            if "error" in str(a.get("prediction", "")).lower():
                continue
            valid_count += 1
            rec = {k: v for k, v in a.items() if k not in INDEX_DROP_FIELDS}
            # Round score fields — the UI only renders them as percentages /
            # 0.01-step slider filters, so full float precision is wasted bytes.
            for k, nd in (("ai_likelihood", 4), ("avg_ai_likelihood", 4),
                          ("max_ai_likelihood", 4), ("fraction_ai_content", 3)):
                v = to_num(rec.get(k))
                rec[k] = round(v, nd) if v is not None else None
            # Hard cap: never emit more than the first 20 words of text.
            if rec.get("text"):
                rec["text"] = first_words(rec["text"], TEXT_WORD_LIMIT)
                max_words = max(max_words, len(rec["text"].split()))
            f.write(json.dumps(rec, separators=(",", ":"), ensure_ascii=False))
            f.write("\n")
    print(f"[{dataset_type}] wrote {index_path} ({os.path.getsize(index_path)/1e6:.1f} MB, "
          f"{valid_count:,} rows, max text words={max_words})")

    return {"dataset_type": dataset_type, "total": valid_count, "records": len(articles)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", nargs="+",
                    default=["recent_news", "opinions", "reporters"])
    args = ap.parse_args()

    now = datetime.now()
    results = []
    for ds in args.datasets:
        r = build_dataset(ds, now)
        if r:
            results.append(r)

    # Bump the data version so clients bust their IndexedDB / HTTP caches.
    counts_path = os.path.join(HERE, "additional_data", "dataset_counts.json")
    try:
        with open(counts_path) as f:
            counts = json.load(f)
    except (OSError, ValueError):
        counts = {}
    counts["last_updated"] = now.strftime("%Y-%m-%dT%H:%M:%S")
    for r in results:
        counts[r["dataset_type"]] = r["total"]
    with open(counts_path, "w") as f:
        json.dump(counts, f, indent=2)
    print(f"\nUpdated {counts_path}: last_updated={counts['last_updated']}")
    print("Done.")


if __name__ == "__main__":
    main()
