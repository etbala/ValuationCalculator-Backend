import yfinance as yf
from datetime import datetime
import json
import math
import pandas as pd

# Static values
RISK_PREMIUM = 0.05
EPS_GROWTH = 0.05

def get_risk_free_rate():
    try:
        treasury_ticker = "^TYX"  # 30-Year Treasury bond yield ticker
        treasury = yf.Ticker(treasury_ticker)
        data = treasury.history(period="1d")
        if not data.empty:
            return data["Close"].iloc[-1] / 100  # Convert percentage to decimal
        return 0.04  # Default fallback
    except Exception as e:
        return 0.04  # Default fallback 

def months_to_fye(last_fiscal, next_fiscal):
    try:
        current_time = datetime.now().timestamp()
        if current_time < next_fiscal:
            fiscal_end = datetime.fromtimestamp(next_fiscal)
        else:
            fiscal_end = datetime.fromtimestamp(last_fiscal)
        
        current_date = datetime.now()
        months_remaining = (fiscal_end.year - current_date.year) * 12 + (fiscal_end.month - current_date.month)
        return months_remaining if months_remaining >= 0 else 0
    except Exception as e:
        print(f"Error calculating months to fiscal year end: {e}")
        return None

def parse_earnings_forecast(forecast_df):
    """Parses the earnings forecast dataframe to extract fy1 and fy2 values."""
    try:
        fy1_avg = None
        fy2_avg = None
        
        if isinstance(forecast_df, pd.DataFrame):
            # Extract 0y (current year) average EPS
            if 'avg' in forecast_df.columns:
                fy1_row = forecast_df.loc[forecast_df.index == '0y']
                fy2_row = forecast_df.loc[forecast_df.index == '+1y']
                
                fy1_avg = fy1_row['avg'].values[0] if not fy1_row.empty else None
                fy2_avg = fy2_row['avg'].values[0] if not fy2_row.empty else None
        
        return fy1_avg, fy2_avg
    except Exception as e:
        print(f"Error parsing earnings forecast: {e}")
        return None, None

def get_stock_data(ticker):
    # Initialize dictionary
    stock_data = {}

    try:
        # Download stock data
        stock = yf.Ticker(ticker)

        # Financials and other info
        info = stock.info
        balance_sheet = stock.balance_sheet
        earnings_forecast = stock.get_earnings_estimate()

        # Parse earnings forecast for fy1 and fy2
        fy1_avg, fy2_avg = parse_earnings_forecast(earnings_forecast)

        stock_data["fy0"] = round(info.get("trailingEps", 0), 2)
        stock_data["fy1"] = round(fy1_avg, 2)
        stock_data["fy2"] = round(fy2_avg, 2)

        # Calculate months to fiscal year end
        last_fiscal = info.get("lastFiscalYearEnd", None)
        next_fiscal = info.get("nextFiscalYearEnd", None)
        stock_data["monthsToFYE"] = months_to_fye(last_fiscal, next_fiscal)

        stock_data["payout_ratio"] = info.get("payoutRatio", None)
        stock_data["eps_growth"] = EPS_GROWTH
        stock_data["book_value"] = round(info.get("bookValue"), 2)
        stock_data["stock_price"] = round(info.get("currentPrice"), 2)

        # Shares, Debt, and Cash
        stock_data["shares"] = info.get("sharesOutstanding", None)
        total_debt = balance_sheet.loc["Total Debt", :].iloc[0] if "Total Debt" in balance_sheet.index else None
        cash = balance_sheet.loc["Cash And Cash Equivalents", :].iloc[0] if "Cash And Cash Equivalents" in balance_sheet.index else None
        stock_data["debt"] = total_debt
        stock_data["cash"] = cash

        # Risk-free rate
        stock_data["risk_free_rate"] = round(get_risk_free_rate(), 4)
        stock_data["beta"] = info.get("beta")
        stock_data["risk_premium"] = RISK_PREMIUM

        # Dividend Rates
        stock_data["forward_dividend_rate"] = info.get("dividendRate")
        stock_data["trailing_dividend_rate"] = info.get("trailingAnnualDividendRate")

        # Return as JSON
        return json.dumps(stock_data, indent=4)

    except Exception as e:
        return json.dumps({"error": str(e)}, indent=4)

# Example usage
ticker = "AAPL"  # Replace with the stock ticker
result = get_stock_data(ticker)
print(result)
