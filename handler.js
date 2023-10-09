'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const Decimal = require('decimal.js');
const puppeteer = require("puppeteer-core");
const chromium = require('chrome-aws-lambda');

module.exports.hello = async function (event, context) {
    await main(event['queryStringParameters']['ticker']);
    
    if(ticker_exists === false) {
        return { 
            statusCode: 400,
        };
    }
    if(yahoo_works === false) {
        return { 
            statusCode: 503,
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
let book_value = "";
let debt = "";
let cash = "";
let fy0 = "";
let fy1 = "";
let fy2 = "";
let risk_free_rate = "";
let forward_dividend_rate = "";
let trailing_dividend_rate = "";

// Static (?) Values
let eps_growth = new Decimal(0.05);
let risk_premium = new Decimal(0.05);

// Calculated Values
let monthsToFYE = -1;

async function scrapeStatistics(ticker) {
    const response = await axios.get(`https://finance.yahoo.com/quote/${ticker}/key-statistics`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    const $ = cheerio.load(response.data);
    
    const invalid_ticker = $('*:contains("Symbols similar to")').length > 0;
    if(invalid_ticker) {
        ticker_exists = false;
        return;
    }
    
    stock_price = $('fin-streamer[data-symbol="' + ticker + '"][data-test="qsp-price"]').attr('value');
    beta = $('span:contains("Beta (5Y Monthly)")').parent().next().text();
    shares = $('span:contains("Shares Outstanding")').eq(0).parent().next().text();
    //payout_ratio = $('span:contains("Payout Ratio")').parent().next().text();
    fiscal_year_end = $('span:contains("Fiscal Year Ends")').parent().next().text();
    book_value = $('span:contains("Book Value Per Share")').parent().next().text();
    debt = $('span:contains("Total Debt")').eq(0).parent().next().text();
    cash = $('span:contains("Total Cash")').eq(0).parent().next().text();
    forward_dividend_rate = $('span:contains("Forward Annual Dividend Rate")').parent().next().text();
    trailing_dividend_rate = $('span:contains("Trailing Annual Dividend Rate")').parent().next().text();
}

async function scrapeAnalytics(ticker) {
    const response = await axios.get(`https://finance.yahoo.com/quote/${ticker}/analysis`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    const $ = cheerio.load(response.data);
    const table = $('table[class="W(100%) M(0) BdB Bdc($seperatorColor) Mb(25px)"]').eq(0);
    const year_ago_eps_row = table.find('tr:contains("Year Ago EPS")');
    const avg_estimate_row = table.find('tr:contains("Avg. Estimate")');

    fy0 = year_ago_eps_row.find('td').eq(3).text();
    fy1 = year_ago_eps_row.find('td').eq(4).text();
    fy2 = avg_estimate_row.find('td').eq(4).text();
}

async function scrapeCashFlow(ticker) {
    async function fetchPageHTML(ticker) {
        const browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });
        const page = await browser.newPage();
    
        await page.goto(`https://finance.yahoo.com/quote/${ticker}/cash-flow?p=${ticker}`);
    
        await Promise.all([
            page.click('button[aria-label="Financing Cash Flow"]'),
            page.waitForSelector('button[aria-label="Cash Flow from Continuing Financing Activities"]', { visible: true })
        ]);
        await Promise.all([
            page.click('button[aria-label="Cash Flow from Continuing Financing Activities"]'),
            page.waitForSelector('button[aria-label="Net Common Stock Issuance"]', { visible: true })
        ]);
        await Promise.all([
            page.click('button[aria-label="Operating Cash Flow"]'),
            page.waitForSelector('button[aria-label="Cash Flow from Continuing Operating Activities"]', { visible: true })
        ]);
        await Promise.all([
            page.click('button[aria-label="Cash Flow from Continuing Operating Activities"]'),
            page.waitForSelector('div[title="Net Income from Continuing Operations"]', { visible: true })
        ]);
    
        const content = await page.content();
        await browser.close();
        return content;
    }
    
    async function getData(html, label) {
        const $ = cheerio.load(html);
        const labelSpan = $(`span:contains(${label})`);
        if (labelSpan.length === 0) return null;
    
        const rowDiv = labelSpan.parent().parent().parent();
        const valueDiv = rowDiv.children().eq(1);
        const value = valueDiv.find('span').text();
        
        return value;
    }

    const html = await fetchPageHTML(ticker);
    
    let stock_issuance = await getData(html, 'Net Common Stock Issuance');
    let dividends_paid = await getData(html, 'Cash Dividends Paid');
    let net_income = await getData(html, 'Net Income from Continuing Operations');

    // Convert To Integers & Make swap sign of dividends
    if(stock_issuance === '' || stock_issuance === null)    { stock_issuance = new Decimal(0); } 
    else                                                    { stock_issuance = new Decimal(stock_issuance.replace(/,/g, '')); }
    if(dividends_paid === '' || dividends_paid === null)    { dividends_paid = new Decimal(0); }
    else                                                    { dividends_paid = new Decimal(0).minus(new Decimal(dividends_paid.replace(/,/g, ''))); }
    net_income = new Decimal(net_income.replace(/,/g, ''));

    payout_ratio = dividends_paid.minus(stock_issuance).div(net_income);
    if(payout_ratio.greaterThan(new Decimal(1))) {
        payout_ratio = new Decimal(1);
    } else if(payout_ratio.lessThan(new Decimal(0))) {
        payout_ratio = new Decimal(0);
    }

    console.log("Payout Ratio: " + parseFloat(payout_ratio).toFixed(2));
    console.log("Plowback Rate: " + parseFloat(new Decimal(1).minus(payout_ratio)).toFixed(2));
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
    if(payout_ratio.lessThan(0)) { payout_ratio = "N/A"; }
    
    if(shares === "N/A" || debt === "N/A" || cash === "N/A" || fy0 === "N/A" || fy1 === "N/A" || fy2 === "N/A" || 
       stock_price === "N/A" || beta === "N/A" || risk_free_rate === "N/A" || book_value === "N/A") {
        yahoo_works = false;
        return;
    }
    
    // Shares
    let unit = shares.slice(-1);
    shares = shares.replace(/[^\d.-]/g, '');
    shares = new Decimal(parseFloat(shares));
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
    debt = new Decimal(parseFloat(debt));
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
    cash = new Decimal(parseFloat(cash));
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
    fy0                     = new Decimal(fy0);
    fy1                     = new Decimal(fy1);
    fy2                     = new Decimal(fy2);
    stock_price             = new Decimal(stock_price);
    beta                    = new Decimal(beta);
    book_value              = new Decimal(book_value);
    risk_free_rate          = new Decimal(risk_free_rate).div(100);
}

function calculateMonthsToFYE() {
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
}

function generateJSON() {
    let dict = {};

    dict["fy0"] = parseFloat(fy0);
    dict["fy1"] = parseFloat(fy1);
    dict["fy2"] = parseFloat(fy2);
    dict["monthsToFYE"] = monthsToFYE;
    dict["payout_ratio"] = parseFloat(payout_ratio).toFixed(2);
    dict["eps_growth"] = parseFloat(eps_growth);
    dict["book_value"] = parseFloat(book_value);
    dict["stock_price"] = parseFloat(stock_price);
    dict["shares"] = parseFloat(shares);
    dict["debt"] = parseFloat(debt);
    dict["cash"] = parseFloat(cash);
    dict["risk_free_rate"] = parseFloat(risk_free_rate);
    dict["beta"] = parseFloat(beta);
    dict["risk_premium"] = parseFloat(risk_premium);
    dict["forward_dividend_rate"] = forward_dividend_rate;
    dict["trailing_dividend_rate"] = trailing_dividend_rate;

    return JSON.stringify(dict);
}

async function main(ticker) {
    ticker_exists = true;
    yahoo_works = true;
    
    if(ticker.length > 4 || ticker === '') {
        ticker_exists = false;
        return;
    }
    
    await Promise.all([scrapeStatistics(ticker), scrapeAnalytics(ticker), scrapeCashFlow(ticker), scrapeTreasuryYield()]);
    if(ticker_exists === false) { return; }
    translationLayer();
    if(yahoo_works === false) { return; }
    calculateMonthsToFYE();

    console.log(generateJSON());
}