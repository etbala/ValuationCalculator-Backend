'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const Decimal = require('decimal.js');

module.exports.hello = async function (event, context) {
    await main(event['queryStringParameters']['ticker']);
    
    if(ticker_exists === false) {
        return { 
            statusCode: 404,
            body: { 'error_type': 'invalid_ticker'},
        };
    }
    if(yahoo_works === false) {
        return { 
            statusCode: 404,
            body: { 'error_type': 'yahoo_down'},
        };
    }
    
    let return_JSON = generateJSON();
    const response = {
        statusCode: 200,
        body: return_JSON,
    };
    return response;
};

let ticker_exists = true;
let yahoo_works = true;

// Scraped Values
let stock_price = "";
let beta = "";
let shares = "";
let payout_ratio = "";
let fiscal_year_end = "";
let monthsToFYE = -1;
let book_value = "";
let debt = "";
let cash = "";
let fy0 = "";
let fy1 = "";
let fy2 = "";
let risk_free_rate = "";

// Static (?) Values
let eps_growth = new Decimal(0.05);
let risk_premium = new Decimal(0.05);

//  Calculated Values
let adjusted_beta = new Decimal(0);
let cost_of_equity = new Decimal(0);
let growth_rate = new Decimal(0);
let fe0 = new Decimal(0);
let fe1 = new Decimal(0);
let fe2 = new Decimal(0);
let plowback_rate = new Decimal(0);

// Discounted Cash Flow Calculations (15 Transition Years)
let g = [];                                         // Growth in New Income or EPS
let k = [];                                         // Plowback Rate
let eps = [];                                       // Earnings Per Share before Extraordinary Items
let net_new_equity_investments = [];                // Net New Equity Investments
let fcfe = [];                                      // Free Cash Flow to Equity
let fcfe_growth = [];                               // Free Cash Flow to Equity Growth
let book_value_per_share = [];                      // Book Value Per Share
let roe = [];                                       // Return on Book Equity
let roi = [];                                       // Return on new equity Investments
let ri = [];                                        // Residual Income (EVA for Shareholders)
let roe_less_re = [];                               // ROE - Cost of Equity

// Discounted Free Cash Flow Valuation
let fcfe_pv                                 = new Decimal(0);   // Present Value of FCFE during first 15 years
let continuing_value_cash_flow_based        = new Decimal(0);   // Continuing value based on cash flows beyond Year 15
let intrinsic_value_of_equity_per_share_dfc = new Decimal(0);   // Discounted Free Cash Flow Valuation
let profit_volume_ratio                     = new Decimal(0);   // Profit Volume Ratio

/*// Discounted Residual Income Valuation
let residual_income_pv                      = "";   // Residual Income Present Value first 15 years
let residual_income_cv                      = "";   // Residual Income Continuing Value after 15 years
let intrinsic_value_of_equity_per_share_ri  = "";   // Discounted Residual Income (EVA for shareholders) Valuation*/

// Value of assets-in-place and PVGO
let assets_in_place_value                   = new Decimal(0);   // Value of Assets in Place
let pvgo                                    = new Decimal(0);   // Present Value of Growth Opportunities

// Firm Valuation
let value_of_equity                         = new Decimal(0);   // Value of Equity
let total_firm_value                        = new Decimal(0);   // Total Firm Value
let total_enterprise_value                  = new Decimal(0);   // Total Enterprise Value


async function scrapeStatistics(ticker) {
    const response = await axios.get(`https://finance.yahoo.com/quote/${ticker}/key-statistics`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });
    
    if(response.request._redirectable._redirectCount > 1) {
        ticker_exists = false;
        return;
    }

    const $ = cheerio.load(response.data);
    stock_price = $('fin-streamer[data-symbol="' + ticker + '"][data-test="qsp-price"]').attr('value');
    beta = $('span:contains("Beta (5Y Monthly)")').parent().next().text();
    shares = $('span:contains("Shares Outstanding")').eq(0).parent().next().text();
    payout_ratio = $('span:contains("Payout Ratio")').parent().next().text();
    fiscal_year_end = $('span:contains("Fiscal Year Ends")').parent().next().text();
    book_value = $('span:contains("Book Value Per Share")').parent().next().text();
    debt = $('span:contains("Total Debt")').eq(0).parent().next().text();
    cash = $('span:contains("Total Cash")').eq(0).parent().next().text();
}

async function scrapeAnalytics(ticker) {
    const response = await axios.get(`https://finance.yahoo.com/quote/${ticker}/analysis`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    if(response.request._redirectable._redirectCount > 1) {
        ticker_exists = false;
        return;
    }

    const $ = cheerio.load(response.data);
    const table = $('table[class="W(100%) M(0) BdB Bdc($seperatorColor) Mb(25px)"]').eq(0);
    const year_ago_eps_row = table.find('tr:contains("Year Ago EPS")');
    const avg_estimate_row = table.find('tr:contains("Avg. Estimate")');

    fy0 = year_ago_eps_row.find('td').eq(3).text();
    fy1 = year_ago_eps_row.find('td').eq(4).text();
    fy2 = avg_estimate_row.find('td').eq(4).text();
}

async function scrapeTreasuryYield() {
    const response = await axios.get(`https://finance.yahoo.com/quote/%5ETYX`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    const $ = cheerio.load(response.data);
    risk_free_rate = $('fin-streamer[data-symbol="^TYX"]').attr('value');
}

// Converts scraped values to useable decimal/integer formats
function translationLayer() {
    // Payout Ratio
    payout_ratio = payout_ratio.replace(/[^\d.-]/g, '');
    payout_ratio = new Decimal(payout_ratio).div(100);

    // Shares
    let unit = shares.slice(-1);
    shares = shares.replace(/[^\d.-]/g, '');
    shares = new Decimal(parseInt(shares));
    if(unit == 'B') {
        shares = shares.times(new Decimal(1000000000));
    } else if(unit == 'M') {
        shares = shares.times(new Decimal(1000000));
    } else if(unit == 'k') {
        shares = shares.times(new Decimal(1000));
    }

    // Debt
    unit = debt.slice(-1);
    debt = debt.replace(/[^\d.-]/g, '');
    debt = new Decimal(parseInt(debt));
    if(unit == 'B') {
        debt = debt.times(new Decimal(1000000000));
    } else if(unit == 'M') {
        debt = debt.times(new Decimal(1000000));
    } else if(unit == 'k') {
        debt = debt.times(new Decimal(1000));
    }

    // Cash
    unit = cash.slice(-1);
    cash = cash.replace(/[^\d.-]/g, '');
    cash = new Decimal(parseInt(cash));
    if(unit == 'B') {
        cash = cash.times(new Decimal(1000000000));
    } else if(unit == 'M') {
        cash = cash.times(new Decimal(1000000));
    } else if(unit == 'k') {
        cash = cash.times(new Decimal(1000));
    }

    // Remove non digit or '.' characters from strings just in case
    fy0 = fy0.replace(/[^\d.-]/g, '');
    fy1 = fy1.replace(/[^\d.-]/g, '');
    fy2 = fy2.replace(/[^\d.-]/g, '');
    stock_price = stock_price.replace(/[^\d.-]/g, '');
    beta = beta.replace(/[^\d.-]/g, '');
    book_value = book_value.replace(/[^\d.-]/g, '');
    risk_free_rate = risk_free_rate.replace(/[^\d.-]/g, '');

    // Make sure system knows decimal numbers with fixed length
    fy0             = new Decimal(fy0);
    fy1             = new Decimal(fy1);
    fy2             = new Decimal(fy2);
    stock_price     = new Decimal(stock_price);
    beta            = new Decimal(beta);
    book_value      = new Decimal(book_value);
    risk_free_rate  = new Decimal(risk_free_rate);
}

// Calculates valuation based on current values
function updateValuation() {
    // Computing Cost of Equity
    adjusted_beta = new Decimal(1).div(3).plus(new Decimal(2).div(3).times(beta));
    cost_of_equity = adjusted_beta.times(risk_premium).plus(risk_free_rate);

    // Date Handling
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let fiscal_month_str = fiscal_year_end.substring(0,3);

    let fiscal_month = -1;
    for(let i = 0; i < months.length; i++) {
        if(fiscal_month_str == months[i]) {
            fiscal_month = i;
            break;
        }
    }

    let current_month = (new Date()).getMonth();
    if(current_month > fiscal_month) {
        monthsToFYE = (fiscal_month + 12) - current_month;
    } else {
        monthsToFYE = fiscal_month - current_month;
    }

    growth_rate = fy2.div(fy1).sub(1);
    fe0 = new Decimal(monthsToFYE).div(12).times(fy0).plus(new Decimal(1).minus(new Decimal(monthsToFYE).div(12)).times(fy1));
    fe1 = new Decimal(monthsToFYE).div(12).times(fy1).plus(new Decimal(1).minus(new Decimal(monthsToFYE).div(12)).times(fy2));
    fe2 = new Decimal(fe1).times(new Decimal(1).plus(growth_rate));

    plowback_rate = new Decimal(1).sub(payout_ratio);
    if(plowback_rate.lessThan(0)) { // Plowback cannot be negative
        plowback_rate = new Decimal(0);
    }

    // Fill Constants in DCF Model
    g[2] = growth_rate;
    k[0] = plowback_rate;
    k[1] = plowback_rate;
    eps[0] = fe0;
    eps[1] = fe1;
    eps[2] = fe2;
    book_value_per_share[0] = book_value;

    // Table Calculations
    let temp = Decimal.exp(new Decimal(1).div(15).times(Decimal.log(eps_growth.div(growth_rate), Decimal.exp(1))));
    for(let i = 3; i <= 16; i++) { g[i] = new Decimal(g[i-1]).times(temp); }
    for(let i = 2; i <= 16; i++) { k[i] = new Decimal(k[i-1]).minus(plowback_rate.minus((eps_growth.dividedBy(cost_of_equity))).dividedBy(new Decimal(15))); }
    for(let i = 3; i <= 16; i++) { eps[i] = new Decimal(eps[i-1]).times((g[i].plus(new Decimal(1)))); }
    for(let i = 0; i <= 16; i++) { net_new_equity_investments[i] = k[i].times(eps[i]); }
    for(let i = 0; i <= 16; i++) { fcfe[i] = new Decimal(eps[i]).minus(net_new_equity_investments[i]); }
    for(let i = 1; i <= 16; i++) { fcfe_growth[i] = new Decimal(fcfe[i]).dividedBy(fcfe[i-1]).minus(new Decimal(1)); }
    for(let i = 1; i <= 16; i++) { book_value_per_share[i] = new Decimal(book_value_per_share[i-1]).plus(eps[i]).minus(fcfe[i]); }
    for(let i = 1; i <= 16; i++) { roe[i] = new Decimal(eps[i]).dividedBy(book_value_per_share[i-1]); }
    for(let i = 1; i <= 16; i++) { roi[i] = new Decimal(eps[i]).minus(eps[i-1]).dividedBy(net_new_equity_investments[i-1]); }
    for(let i = 1; i <= 16; i++) { roe_less_re[i] = new Decimal(roe[i]).minus(cost_of_equity); }
    for(let i = 1; i <= 16; i++) { ri[i] = new Decimal(roe_less_re[i]).times(book_value_per_share[i-1]); }

    // Discounted Residual Income (EVA for Shareholders) Valuation
    //residual_income_pv = 0;
    //for(let i = 1; i <= 16; i++) { residual_income_pv = residual_income_pv + ri[i]/((1+cost_of_equity)**i); }
    //residual_income_cv = (1/(1+cost_of_equity) ** 15) * (ri[16]/cost_of_equity+(eps[16]*(eps_growth/cost_of_equity)*(cost_of_equity-cost_of_equity))/(cost_of_equity*(cost_of_equity-eps_growth)));
    //intrinsic_value_of_equity_per_share_ri = book_value + residual_income_pv + residual_income_cv;

    // Discounted Free Cash Flow Valuation
    fcfe_pv = new Decimal(0);
    for(let i = 1; i <= 16; i++) { fcfe_pv = fcfe_pv.plus(fcfe[i].div(Decimal.pow(new Decimal(1).plus(cost_of_equity), i))); }
    continuing_value_cash_flow_based = new Decimal(1)
        .div(Decimal.pow(new Decimal(1).plus(cost_of_equity), 15))
        .times(fcfe[16].div(cost_of_equity.minus(eps_growth)));
    intrinsic_value_of_equity_per_share_dfc = fcfe_pv.plus(continuing_value_cash_flow_based);
    profit_volume_ratio = stock_price.div(intrinsic_value_of_equity_per_share_dfc);

    // Value of assets in place & PVGO
    assets_in_place_value = fe1.dividedBy(cost_of_equity);
    pvgo = intrinsic_value_of_equity_per_share_dfc.minus(assets_in_place_value);

    // Firm Valuation
    value_of_equity = intrinsic_value_of_equity_per_share_dfc.times(shares);
    total_firm_value = value_of_equity.plus(debt);
    total_enterprise_value = total_firm_value.minus(cash);
}

function generateJSON() {
    let dict = {};

    dict["fy0"] = parseFloat(fy0).toFixed(2);
    dict["fy1"] = parseFloat(fy1).toFixed(2);
    dict["fy2"] = parseFloat(fy2).toFixed(2);
    dict["monthsToFYE"] = monthsToFYE;
    dict["fe0"] = parseFloat(fe0).toFixed(2);
    dict["fe1"] = parseFloat(fe1).toFixed(2);
    dict["fe2"] = parseFloat(fe2).toFixed(2);
    dict["growth_rate"] = parseFloat(growth_rate).toFixed(3);
    dict["plowback_rate"] = parseFloat(plowback_rate).toFixed(2);
    dict["eps_growth"] = parseFloat(eps_growth);
    dict["book_value"] = parseFloat(book_value).toFixed(2);
    dict["stock_price"] = parseFloat(stock_price).toFixed(2);
    dict["shares"] = parseFloat(shares);
    dict["debt"] = parseFloat(debt);
    dict["cash"] = parseFloat(cash);
    dict["risk_free_rate"] = parseFloat(risk_free_rate);
    dict["beta"] = parseFloat(beta);
    dict["adjusted_beta"] = parseFloat(adjusted_beta).toFixed(2);
    dict["risk_premium"] = parseFloat(risk_premium).toFixed(2);
    dict["cost_of_equity"] = parseFloat(cost_of_equity).toFixed(4);
    dict["intrinsic_equity_per_share"] = parseFloat(intrinsic_value_of_equity_per_share_dfc).toFixed(2);
    dict["profit_volume_ratio"] = parseFloat(profit_volume_ratio).toFixed(2);
    dict["assets_in_place"] = parseFloat(assets_in_place_value).toFixed(2);
    dict["pvgo"] = parseFloat(pvgo).toFixed(2);
    dict["value_of_equity"] = parseFloat(value_of_equity).toFixed(2);
    dict["total_firm_value"] = parseFloat(total_firm_value).toFixed(2);
    dict["total_enterprise_value"] = parseFloat(total_enterprise_value).toFixed(2);

    return JSON.stringify(dict);
}

async function main(ticker) {
    await Promise.all([scrapeStatistics(ticker), scrapeAnalytics(ticker), scrapeTreasuryYield()]);
    if(ticker_exists === false || yahoo_works === false) { return; }
    translationLayer();
    updateValuation();
    console.log(generateJSON());
}