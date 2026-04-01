#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EmailUnsubscribeStack } from '../lib/email-unsubscribe-stack';

const app = new cdk.App();
const envName = app.node.tryGetContext('env') || 'prod';
const stackName = envName === 'prod' ? 'EmailUnsubscribeStack' : `EmailUnsubscribeStack-${envName}`;

new EmailUnsubscribeStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
