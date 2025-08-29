const express = require('express');
const Stripe = require('stripe');
const { google } = require('googleapis');
const Airtable = require('airtable');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY
}).base('appUNIsu8KgvOlmi0');

// Gmail OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Middleware
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));

// Logging
let logs = [];

function addLog(message) {
  const timestamp = new Date().toISOString();
  logs.push({ timestamp, message });
  console.log(`[${timestamp}] ${message}`);
  if (logs.length > 50) logs = logs.slice(-50);
}

// Send Gmail alert
async function sendGmailAlert(paymentData) {
  try {
    const subject = `🚨 Payment Failed Alert - ${paymentData.customer_email}`;
    const body = `
Payment Failure Detected!

Details:
- Payment ID: ${paymentData.payment_id}
- Customer: ${paymentData.customer_email}
- Amount: $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency.toUpperCase()}
- Failure Code: ${paymentData.failure_code}
- Failure Message: ${paymentData.failure_message}
- Date: ${paymentData.failed_at}

Please review and take appropriate action.
    `;

    const message = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `To: ${process.env.ALERT_EMAIL || 'admin@example.com'}`,
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });

    addLog(`Gmail alert sent for payment ${paymentData.payment_id}`);
  } catch (error) {
    addLog(`Error sending Gmail alert: ${error.message}`);
  }
}

// Add to Airtable
async function addToAirtable(paymentData) {
  try {
    const table = airtable('Failed Payments');
    
    const record = await table.create([{
      fields: {
        'Payment ID': paymentData.payment_id,
        'Customer Email': paymentData.customer_email || 'Unknown',
        'Amount': paymentData.amount / 100,
        'Currency': paymentData.currency.toUpperCase(),
        'Failure Code': paymentData.failure_code || 'Unknown',
        'Failure Message': paymentData.failure_message || 'Unknown',
        'Failed At': paymentData.failed_at,
        'Status': 'New',
        'Created At': new Date().toISOString()
      }
    }]);

    addLog(`Added to Airtable: ${record[0].id}`);
    return record[0];
  } catch (error) {
    addLog(`Error adding to Airtable: ${error.message}`);
    throw error;
  }
}

// Process failed payment
async function processFailedPayment(event) {
  try {
    let paymentData = {};

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      paymentData = {
        payment_id: pi.id,
        customer_email: pi.receipt_email || 'Unknown',
        amount: pi.amount,
        currency: pi.currency,
        failure_code: pi.last_payment_error?.code,
        failure_message: pi.last_payment_error?.message,
        failed_at: new Date(event.created * 1000).toISOString()
      };
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      paymentData = {
        payment_id: invoice.id,
        customer_email: invoice.customer_email || 'Unknown',
        amount: invoice.amount_due,
        currency: invoice.currency,
        failure_code: 'invoice_payment_failed',
        failure_message: 'Invoice payment failed',
        failed_at: new Date(event.created * 1000).toISOString()
      };
    } else if (event.type === 'charge.failed') {
      const charge = event.data.object;
      paymentData = {
        payment_id: charge.id,
        customer_email: charge.receipt_email || charge.billing_details?.email || 'Unknown',
        amount: charge.amount,
        currency: charge.currency,
        failure_code: charge.failure_code,
        failure_message: charge.failure_message,
        failed_at: new Date(event.created * 1000).toISOString()
      };
    }

    await sendGmailAlert(paymentData);
    await addToAirtable(paymentData);
    addLog(`Successfully processed failed payment: ${paymentData.payment_id}`);
  } catch (error) {
    addLog(`Error processing failed payment: ${error.message}`);
    throw error;
  }
}

// Webhook endpoint
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    addLog(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (['payment_intent.payment_failed', 'invoice.payment_failed', 'charge.failed'].includes(event.type)) {
    try {
      await processFailedPayment(event);
      addLog(`Webhook processed: ${event.type}`);
    } catch (error) {
      addLog(`Error processing webhook: ${error.message}`);
      return res.status(500).send('Internal Server Error');
    }
  }

  res.json({ received: true });
});

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'Payment Monitor',
    status: 'running',
    endpoints: {
      'GET /': 'Status and available endpoints',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /test': 'Manual test run',
      'POST /webhook/stripe': 'Stripe webhook endpoint'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.get('/logs', (req, res) => {
  res.json({ logs: logs.slice(-20) });
});

app.post('/test', async (req, res) => {
  try {
    const testData = {
      payment_id: 'test_' + Date.now(),
      customer_email: 'test@example.com',
      amount: 2500,
      currency: 'usd',
      failure_code: 'card_declined',
      failure_message: 'Your card was declined.',
      failed_at: new Date().toISOString()
    };

    await sendGmailAlert(testData);
    await addToAirtable(testData);
    
    res.json({ success: true, message: 'Test completed', testData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  addLog(`Payment Monitor started on port ${port}`);
});

module.exports = app;