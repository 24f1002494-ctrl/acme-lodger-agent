import json
import re
import sqlite3
from typing import Any

import httpx
import pandas as pd
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"}
DB_CONN = sqlite3.connect(":memory:", check_same_thread=False)
DATABASE_READY = False


def env(name: str) -> str:
    import os
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def upstream(path: str) -> str:
    from urllib.parse import urlencode
    return "https://exam.sanand.workers.dev/questionData?" + urlencode({"email": env("QUIZ_EMAIL"), "quizSign": env("QUIZ_SIGN"), "questionId": "q-ledger-agent-server", "path": path})


def init_database() -> None:
    global DATABASE_READY
    if DATABASE_READY:
        return
    with httpx.Client(timeout=12.0, headers=HEADERS) as client:
        print("Fetching currency rates from /rates...")
        resp_rates = client.get(upstream("/rates"))
        resp_rates.raise_for_status()
        usd_rates = resp_rates.json()["usd_per_unit"]
        print("Currency Rates loaded")
        print("Fetching raw order ledger from /export...")
        resp_export = client.get(upstream("/export"))
        resp_export.raise_for_status()
        rows = [json.loads(line) for line in resp_export.text.strip().splitlines() if line.strip()]
        print(f"Total raw records downloaded: {len(rows)}")

    df = pd.DataFrame(rows)
    df["created_at_utc"] = pd.to_datetime(df["created_at"], format="ISO8601", utc=True)
    df["updated_at_utc"] = pd.to_datetime(df["updated_at"], format="ISO8601", utc=True)
    df = df.sort_values("updated_at_utc", kind="mergesort").drop_duplicates(subset=["id"], keep="last").copy()
    print(f"Total verified active orders: {len(df)}")
    ist_created = df["created_at_utc"].dt.tz_convert("Asia/Kolkata")
    df["created_date"] = ist_created.dt.strftime("%Y-%m-%d")
    df["created_month"] = ist_created.dt.strftime("%Y-%m")
    df["created_year"] = ist_created.dt.year
    df["rate_to_usd"] = df["currency"].map(usd_rates)
    if df["rate_to_usd"].isna().any():
        missing = sorted(df.loc[df["rate_to_usd"].isna(), "currency"].dropna().astype(str).unique())
        raise RuntimeError(f"Missing USD rate for currency: {missing}")
    df["amount_usd"] = df["amount"] * df["rate_to_usd"]
    df.drop(columns=["created_at_utc", "updated_at_utc"]).to_sql("orders", DB_CONN, index=False, if_exists="replace")
    DATABASE_READY = True
    print("In-memory SQLite database ready.")

MONTH_MAP = {"january":"01","february":"02","march":"03","april":"04","may":"05","june":"06","july":"07","august":"08","september":"09","october":"10","november":"11","december":"12"}
PRODUCTS = ["Air Fryer", "Rice Cooker", "Juicer", "Toaster", "Mixer", "Kettle", "Blender", "Grinder"]
REGIONS = ["North", "South", "East", "West", "Central"]


def parse_question_to_sql(question: str):
    q_low = question.lower()
    conditions = []
    if re.search(r"\brefund(ed|s)?\b", q_low):
        conditions.append("status = 'refunded'")
    elif re.search(r"\b(void|voided|cancel|cancelled)\b", q_low):
        conditions.append("status = 'void'")
    else:
        conditions.append("status = 'paid'")
    for reg in REGIONS:
        if re.search(rf"\b{reg.lower()}\b", q_low):
            conditions.append(f"region = '{reg}'")
            break
    for prod in PRODUCTS:
        if re.search(rf"\b{re.escape(prod.lower())}s?\b", q_low):
            conditions.append(f"product = '{prod}'")
            break
    cust_match = re.search(r"\b(c\d{4})\b", q_low)
    if cust_match:
        conditions.append(f"customer = '{cust_match.group(1).upper()}'")
    year_match = re.search(r"\b(202\d)\b", q_low)
    year_str = year_match.group(1) if year_match else "2026"
    month_num = next((v for k, v in MONTH_MAP.items() if re.search(rf"\b{k}\b", q_low)), None)
    if month_num:
        conditions.append(f"created_month = '{year_str}-{month_num}'")
    elif year_match and "month" not in q_low:
        conditions.append(f"created_year = {year_str}")
    where_clause = " AND ".join(conditions) if conditions else "1=1"
    if any(p in q_low for p in ["which product", "what product", "top-selling product", "best-selling product", "product earned the most"]):
        metric = "SUM(qty)" if any(w in q_low for w in ["qty", "quantity", "units"]) else "SUM(amount_usd)"
        return f"SELECT product FROM orders WHERE {where_clause} GROUP BY product ORDER BY {metric} DESC LIMIT 1", "string"
    if any(p in q_low for p in ["which customer", "what customer", "top customer", "customer spent the most"]):
        return f"SELECT customer FROM orders WHERE {where_clause} GROUP BY customer ORDER BY SUM(amount_usd) DESC LIMIT 1", "string"
    if any(p in q_low for p in ["which region", "what region", "top region", "region earned the most"]):
        return f"SELECT region FROM orders WHERE {where_clause} GROUP BY region ORDER BY SUM(amount_usd) DESC LIMIT 1", "string"
    if any(p in q_low for p in ["distinct customer", "different customer", "unique customer", "how many customer"]):
        return f"SELECT COUNT(DISTINCT customer) FROM orders WHERE {where_clause}", "int"
    if "average" in q_low:
        return f"SELECT ROUND(COALESCE(AVG(amount_usd), 0), 2) FROM orders WHERE {where_clause}", "money"
    if any(p in q_low for p in ["how many orders", "count the", "number of orders", "how many refunded"]):
        return f"SELECT COUNT(*) FROM orders WHERE {where_clause}", "int"
    if any(p in q_low for p in ["how many units", "total quantity", "total units"]):
        return f"SELECT COALESCE(SUM(qty), 0) FROM orders WHERE {where_clause}", "int"
    return f"SELECT ROUND(COALESCE(SUM(amount_usd), 0), 2) FROM orders WHERE {where_clause}", "money"

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


async def answer_question(request: Request) -> dict[str, Any]:
    body = await request.json()
    question = body.get("question", "")
    if not isinstance(question, str) or not question.strip():
        return {"answer": 0}
    init_database()
    sql_query, ans_type = parse_question_to_sql(question)
    print(f"[INCOMING QUESTION] {question}")
    print(f"[SQL EXECUTED] {sql_query}")
    cursor = DB_CONN.cursor()
    cursor.execute(sql_query)
    row = cursor.fetchone()
    val = row[0] if row and row[0] is not None else 0
    if ans_type == "string":
        result = str(val)
    elif ans_type == "int":
        result = int(val)
    else:
        result = round(float(val), 2)
    print(f"[RESPONSE] {result}")
    return {"answer": result}


app.post("/")(answer_question)
app.post("/api")(answer_question)
