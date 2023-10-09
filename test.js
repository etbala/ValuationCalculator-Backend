const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');
const cheerio = require('cheerio');

exports.handler = async (event, context) => {
    try {
        const ticker = event['queryStringParameters']['ticker'];
        main(ticker);
        return context.succeed(result);
    } catch (error) {
        return context.fail(error);
    }
};

async function fetchPageHTML(ticker) {
    const browser = await puppeteer.launch();
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

async function main(ticker) {
    const html = await fetchPageHTML(ticker);
    
    commonStockIssuance = await getData(html, 'Net Common Stock Issuance');
    cashDividendsPaid = await getData(html, 'Cash Dividends Paid');
    cashFlowFromContinuingOperations = await getData(html, 'Cash Flow from Continuing Operating Activities');

    console.log({
        commonStockIssuance,
        cashDividendsPaid,
        cashFlowFromContinuingOperations
    });

    // Convert To Integers
    if(commonStockIssuance === '' || commonStockIssuance === null)  { commonStockIssuance = 0; } 
    else                                                            { commonStockIssuance = parseInt(commonStockIssuance.replace(/,/g, '')); }
    if(cashDividendsPaid === '' || cashDividendsPaid === null)      { cashDividendsPaid = 0; }
    else                                                            { cashDividendsPaid = parseInt(cashDividendsPaid.replace(/,/g, '')); }
    cashFlowFromContinuingOperations = parseInt(cashFlowFromContinuingOperations.replace(/,/g, ''));

    let payout_ratio = parseFloat(-(commonStockIssuance + cashDividendsPaid)/cashFlowFromContinuingOperations).toFixed(2);
    console.log("Payout Ratio: " + payout_ratio);
    console.log("Plowback Rate: " + (1 - payout_ratio).toFixed(2));
}

main("AMD");