// event notifier
//
// required environment variables:
//  AZURE_SERVICE_BUS_NAMESPACE,
//  AZURE_SERVICE_BUS_QUEUE,
//  AZURE_SERVICE_BUS_SHARED_ACCESS_NAME,
//  AZURE_SERVICE_BUS_SHARED_ACCESS_KEY,
//  NOTIFICATION_NUMBER

var express = require('express');
var exec = require('child_process').exec;
var azure = require('azure');
var twilio = null;
var app = express();

// Stats
var stats = {
  'notifications': {
    'sent':         0,
    'errors':       0,
    'last_error':   null,
    'last_sent':    0
  },
  'queue': {
    'read':         0,
    'messages':     0,
    'errors':       0
  },
  'running': {
    'startup':      timestamp(),
    'ready':        0,
    'now':          0
  }
}

// useful globals
var interval_handle = null;

// Retrieve environment variables
function environment_vars() {
  var env = {
    'serviceBusNamespace':        process.env.AZURE_SERVICE_BUS_NAMESPACE,
    'serviceBusQueue':            process.env.AZURE_SERVICE_BUS_QUEUE,
    'serviceBusSharedAccessName': process.env.AZURE_SERVICE_BUS_SHARED_ACCESS_NAME,
    'serviceBusSharedAccessKey':  process.env.AZURE_SERVICE_BUS_SHARED_ACCESS_KEY,
    'twilioSid':                  process.env.TWILIO_SID,
    'twilioAuthToken':            process.env.TWILIO_AUTH_TOKEN,
    'twilioNumber':               process.env.TWILIO_PHONE_NUMBER,
    'notificationNumber':         process.env.NOTIFICATION_NUMBER,
    'sendNotifications':          ((typeof(process.env.SEND_NOTIFICATIONS) != 'undefined') ? 
                                          parseInt(process.env.SEND_NOTIFICATIONS) : 0)
  };
  if(typeof(env['sendNotifications']) != 'undefined') {
    env['sendNotifications'] = parseInt()
  }
  return env;
}

function required_environment_vars_set(vars) {
  if((typeof(vars['serviceBusNamespace']) != 'undefined') &&
        (typeof(vars['serviceBusQueue']) != 'undefined') &&
        (typeof(vars['serviceBusSharedAccessName']) != 'undefined') &&
        (typeof(vars['serviceBusSharedAccessKey']) != 'undefined') &&
        (typeof(vars['twilioSid']) != 'undefined') &&
        (typeof(vars['twilioAuthToken']) != 'undefined') &&
        (typeof(vars['twilioNumber']) != 'undefined') &&
        (typeof(vars['notificationNumber']) != 'undefined')) {
    return true;
  }
  return false;
}

function filter_environment_vars_for_output(env) {
  for(key in env) {
    if((key.toUpperCase().indexOf('KEY') > -1) ||
        (key.toUpperCase().indexOf('AUTH') > -1) ||
        (key.toUpperCase().indexOf('NUMBER') > -1) ||
        (key.toUpperCase().indexOf('SID') > -1)) {
      env[key] = '********';
    } 
  }
  return env;
}

function timestamp() {
  return Math.floor(Date.now() / 1000);
}

function send_notification(env, messages) {
  message_count = Object.keys(messages).length
  if(message_count > 0) {
    var now = timestamp();
    var last_time = 0;
    var last_message = null;
    try {
      var keys = Object.keys(messages).sort();
      last_message = messages[keys[keys.length-1]];
      last_time = last_message['timestamp'];
    } catch(e) {
      last_time = 0
      stats['notifications']['errors']++;
      console.log(e);
    }

    var text = 'Alerts found: ' + message_count;
    if(last_time > 0) {
      text = text + ', Last alert: ' + last_message['timestamp'] + ', Value: ' + last_message['difference'];
    } else {
      text = text + ', Error processing last alert.';
    }
    
    if(env['sendNotifications'] == 1) {
      if(twilio) {
        twilio.sms.messages.create({
          to: env['notificationNumber'],
          from: env['twilioNumber'],
          body: text
        }, function(error, message) {
          if(error) {
            stats['notifications']['errors']++;
            stats['notifications']['last_error'] = error;
            console.log(error);
          } else {
            stats['notifications']['sent']++;
            stats['notifications']['last_sent'] = timestamp();
            console.log('Message sent.  SID: ' + message.sid + ', time: ' + message.dateCreated);
          }
          notifier_timer();
        });
      } else {
        stats['notifications']['errors']++;
        stats['notifications']['last_error'] = 'Twilio client undefined.';
        notifier_timer();
      }
    } else {
      console.log(text);
      notifier_timer();    
    }
  }
}

function terminate_check(env, messages) {
  var message_count = Object.keys(messages).length;
  if(message_count > 0) {
    send_notification(env, messages)
  } else {
    notifier_timer();
  }  
}

function check_for_messages(sbus_service, env, messages) {
  var terminate_interval = false;
  sbus_service.receiveQueueMessage(env['serviceBusQueue'], { isPeekLock: true, timeoutIntervalInS: 5 }, function(err, msg) {
    if(err) {
      if(err == 'No messages to receive') {
        terminate_check(env, messages);
      } else {
        stats['queue']['errors']++;
        console.log(err);
        terminate_check(env, messages);
      }
    } else {
      var body = msg.body
      sbus_service.deleteMessage(msg, function(error) {
        if(!error) {
          stats['queue']['read']++;
          try {
            if(body) {
              var message = JSON.parse(body)
              messages[message.timestamp] = message
              stats['queue']['messages']++;
            }
          } catch(ex) {
            stats['queue']['errors']++;
          }
        } else {
          stats['queue']['errors']++;
        }
        setTimeout(check_for_messages.bind(null, sbus_service, env, messages), 25);
      });
    }
  });
}

function notifier_timer() {
  var env = environment_vars();
  var messages = null;
  if(required_environment_vars_set(env)) {
    if(twilio == null) {
      stats['running']['ready'] = timestamp();
      twilio = require('twilio')(env['twilioSid'], env['twilioAuthToken']);
    }

    messages = {}
    var connection_string = "Endpoint=sb://" + env['serviceBusNamespace'] + 
                            ".servicebus.windows.net/;SharedAccessKeyName=" +
                            env['serviceBusSharedAccessName'] + 
                            ";SharedAccessKey=" + env['serviceBusSharedAccessKey'];
    var sbus_service = new azure.ServiceBusService(connection_string);
    setTimeout(check_for_messages.bind(null, sbus_service, env, messages), 25);
  } else {
    setTimeout(function() {
        notifier_timer();
    }, 250);
  }
}

// Return a 200 for kubernetes healthchecks
app.get('/healthz', function(req, res) {
  res.status(200).end();
});

app.get('/stats', function(req, res) {
  stats['running']['now'] = timestamp();
  res.setHeader('content-type', 'application/json');
  res.write(JSON.stringify(stats, null, 4));
  res.end();
});

app.get('/status', function(req, res) {
  var output = {
    'running':  (stats['running']['ready'] > 0),
    'environment': {
      'complete': required_environment_vars_set(environment_vars()),
      'vars': filter_environment_vars_for_output(environment_vars())
    }        
  }
  res.setHeader('content-type', 'application/json');
  res.write(JSON.stringify(output, null, 4));
  res.end();
});

app.get('/', function(req, res) {
  var poweredBy = process.env.POWERED_BY;
  var release = process.env.WORKFLOW_RELEASE;

  if (typeof(poweredBy) == 'undefined') {
  	poweredBy = 'Deis';
  }

  exec('hostname', function(error, stdout, stderr) {
    container = 'unknown';
    // If exec was successful
    if (error == null) {
      container = stdout.trim();
    }

    res.setHeader('content-type', 'text/plain');
    res.write('Powered by ' + poweredBy + '\nRelease ' + release + ' on ' + container + '\n');
    res.end()
  });
});

/* Use PORT environment variable if it exists */
var port = process.env.PORT || 5000;
server = app.listen(port, function () {
  console.log('Server listening on port %d in %s mode', server.address().port, app.settings.env);
});

/* Start the notification check timer */
notifier_timer(null);
