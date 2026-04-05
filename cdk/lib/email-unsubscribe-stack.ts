import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export class EmailUnsubscribeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------------
    // Environment config — `cdk deploy --context env=dev` for dev stack,
    // omit (or --context env=prod) for production. Prod resource names are
    // preserved as-is for backward compatibility with existing DynamoDB tables.
    // ---------------------------------------------------------------------------
    const envName   = this.node.tryGetContext('env') || 'prod';
    const isProdEnv = envName === 'prod';
    const prefix    = isProdEnv ? 'email-unsubscribe' : `email-unsubscribe-${envName}`;
    const domain    = isProdEnv ? 'unsub.dorangroup.io' : `unsub-${envName}.dorangroup.io`;
    const ssmPrefix = isProdEnv ? '/email-unsubscribe' : `/email-unsubscribe-${envName}`;

    // ---------------------------------------------------------------------------
    // DynamoDB tables
    // ---------------------------------------------------------------------------
    const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `${prefix}-sessions`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const allowlistTable = new dynamodb.Table(this, 'AllowlistTable', {
      tableName: `${prefix}-allowlist`,
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const historyTable = new dynamodb.Table(this, 'HistoryTable', {
      tableName: `${prefix}-history`,
      partitionKey: { name: 'userEmail', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'domain', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
      tableName: `${prefix}-analytics`,
      partitionKey: { name: 'userEmail', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------------
    // Secrets from SSM Parameter Store
    // ---------------------------------------------------------------------------
    const googleClientId = ssm.StringParameter.valueForStringParameter(
      this, `${ssmPrefix}/google-client-id`
    );
    const googleClientSecret = ssm.StringParameter.valueForStringParameter(
      this, `${ssmPrefix}/google-client-secret`
    );
    const sessionSecret = ssm.StringParameter.valueForStringParameter(
      this, `${ssmPrefix}/session-secret`
    );
    const redirectUri = ssm.StringParameter.valueForStringParameter(
      this, `${ssmPrefix}/redirect-uri`
    );

    // ---------------------------------------------------------------------------
    // Lambda function
    // ---------------------------------------------------------------------------
    const srcDir = path.join(__dirname, '../..');
    const appCode = lambda.Code.fromAsset(srcDir, {
      bundling: {
        // Local bundler — runs on the host directly, no Docker required.
        local: {
          tryBundle(outputDir: string): boolean {
            try {
              for (const item of ['server.js', 'public', 'views', 'package.json', 'package-lock.json']) {
                execSync(`cp -r ${path.join(srcDir, item)} ${outputDir}/`); // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
              }
              execSync('npm ci --only=production --silent', { cwd: outputDir });
              return true;
            } catch {
              return false; // fall back to Docker
            }
          },
        },
        // Docker fallback (used if local bundler returns false)
        image: cdk.DockerImage.fromRegistry('node:20-alpine'),
        command: [
          'sh', '-c',
          [
            'apk upgrade --no-cache zlib',  // patch CVE-2026-27171
            'cp -r /asset-input/server.js /asset-input/public /asset-input/views /asset-input/package*.json /asset-output/',
            'cd /asset-output',
            'npm ci --only=production --silent',
          ].join(' && '),
        ],
        user: 'root',
      },
    });

    const fn = new lambda.Function(this, 'AppFunction', {
      functionName: prefix,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'server.handler',
      code: appCode,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        SESSIONS_TABLE: sessionsTable.tableName,
        ALLOWLIST_TABLE: allowlistTable.tableName,
        HISTORY_TABLE: historyTable.tableName,
        ANALYTICS_TABLE: analyticsTable.tableName,
        GOOGLE_CLIENT_ID: googleClientId,
        GOOGLE_CLIENT_SECRET: googleClientSecret,
        SESSION_SECRET: sessionSecret,
        REDIRECT_URI: redirectUri,
      },
    });

    // Grant Lambda read/write access to all tables
    sessionsTable.grantReadWriteData(fn);
    allowlistTable.grantReadWriteData(fn);
    historyTable.grantReadWriteData(fn);
    analyticsTable.grantReadWriteData(fn);

    // ---------------------------------------------------------------------------
    // Lambda Function URL (HTTPS endpoint, no API Gateway cost)
    // ---------------------------------------------------------------------------
    // No CORS config — the frontend is served by the same Lambda (same-origin),
    // so cross-origin access is intentionally blocked at the infrastructure level.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ---------------------------------------------------------------------------
    // Custom domain: ACM cert + CloudFront + Route 53
    // ---------------------------------------------------------------------------
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: 'Z3HPC3HY9MT3NX',
      zoneName: 'dorangroup.io',
    });

    // ACM cert must be in us-east-1 for CloudFront — DNS validation auto-creates
    // the Route 53 CNAME record and renews the cert automatically.
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fnUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      domainNames: [domain],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US + Europe only
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: isProdEnv ? 'unsub' : `unsub-${envName}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution)
      ),
    });

    // ---------------------------------------------------------------------------
    // Seed first admin user (runs once on first deploy if adminEmail context set)
    // Usage: npx cdk deploy --context adminEmail=you@gmail.com
    // ---------------------------------------------------------------------------
    const adminEmail = this.node.tryGetContext('adminEmail');
    if (adminEmail) {
      new cr.AwsCustomResource(this, 'SeedAdminUser', {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: allowlistTable.tableName,
            Item: {
              email:     { S: adminEmail },
              firstName: { S: '' },
              lastName:  { S: '' },
              picture:   { S: '' },
              status:    { S: 'active' },
              isAdmin:   { BOOL: true },
              addedAt:   { S: new Date().toISOString() },
              lastLoginAt: { NULL: true },
            },
            ConditionExpression: 'attribute_not_exists(email)',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`seed-admin-${adminEmail}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [allowlistTable.tableArn],
        }),
      });
    }

    // ---------------------------------------------------------------------------
    // Email infrastructure: admin@dorangroup.io → Gmail forwarding (prod only)
    // ---------------------------------------------------------------------------
    if (isProdEnv) {
      // Note: SES domain identity for dorangroup.io already exists in this account.
      // DKIM verification should be confirmed in the SES console if not already done.

      // S3 bucket for raw email storage with 30-day auto-expiry
      const emailBucket = new s3.Bucket(this, 'EmailBucket', {
        bucketName: `${prefix}-emails`,
        lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });

      // Allow SES to write incoming messages to the bucket
      emailBucket.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${emailBucket.bucketArn}/emails/*`],
        conditions: { StringEquals: { 'aws:Referer': this.account } },
      }));

      // Forwarder Lambda — reads from S3, rewrites headers, sends via SES
      const forwarderFn = new lambda.Function(this, 'SesForwarderFunction', {
        functionName: `${prefix}-ses-forwarder`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        // No bundling step — uses AWS SDK built into the Node.js 20.x runtime
        code: lambda.Code.fromAsset(path.join(__dirname, '../../ses-forwarder')),
        environment: {
          EMAIL_BUCKET: emailBucket.bucketName,
          FROM_EMAIL: 'admin@dorangroup.io',
          FORWARD_TO: 'brad.l.doran@gmail.com',
        },
        reservedConcurrentExecutions: 10,
        timeout: cdk.Duration.seconds(30),
      });

      emailBucket.grantRead(forwarderFn);
      forwarderFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ses:SendRawEmail'],
        resources: ['*'],
      }));

      // SES receipt rule set + rule for admin@dorangroup.io
      const ruleSet = new ses.ReceiptRuleSet(this, 'EmailRuleSet', {
        receiptRuleSetName: `${prefix}-rules`,
      });

      new ses.ReceiptRule(this, 'AdminEmailRule', {
        ruleSet,
        recipients: ['admin@dorangroup.io'],
        scanEnabled: true, // spam + virus scanning
        actions: [
          new sesActions.S3({ bucket: emailBucket, objectKeyPrefix: 'emails/' }),
          new sesActions.Lambda({
            function: forwarderFn,
            invocationType: sesActions.LambdaInvocationType.EVENT,
          }),
        ],
      });

      // Activate the receipt rule set (SES only processes messages for the active set)
      new cr.AwsCustomResource(this, 'ActivateRuleSet', {
        onCreate: {
          service: 'SES',
          action: 'setActiveReceiptRuleSet',
          parameters: { RuleSetName: ruleSet.receiptRuleSetName },
          physicalResourceId: cr.PhysicalResourceId.of(`${prefix}-active-ruleset`),
        },
        onDelete: {
          service: 'SES',
          action: 'setActiveReceiptRuleSet',
          parameters: {},
          physicalResourceId: cr.PhysicalResourceId.of(`${prefix}-active-ruleset`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });

      // Route 53 MX record — directs dorangroup.io inbound mail to SES
      new route53.MxRecord(this, 'EmailMxRecord', {
        zone: hostedZone,
        values: [{ priority: 10, hostName: 'inbound-smtp.us-east-1.amazonaws.com' }],
      });

      // Budget alert — notify if SES costs exceed $2.40/month (80% of $3)
      new budgets.CfnBudget(this, 'SesBudget', {
        budget: {
          budgetName: `${prefix}-ses`,
          budgetLimit: { amount: 3, unit: 'USD' },
          timeUnit: 'MONTHLY',
          budgetType: 'COST',
          costFilters: { Service: ['Amazon Simple Email Service'] } as any,
        },
        notificationsWithSubscribers: [{
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: 'brad.l.doran@gmail.com' }],
        }],
      });
    }

    // ---------------------------------------------------------------------------
    // GitHub Actions OIDC provider + deploy role (prod only — account-level singleton)
    // ---------------------------------------------------------------------------
    if (isProdEnv) {
      // Import the existing GitHub OIDC provider (account-level singleton — do not recreate)
      const githubOidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this, 'GitHubOidcProvider',
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`
      );

      const deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
        roleName: 'email-unsubscribe-github-deploy',
        assumedBy: new iam.WebIdentityPrincipal(
          githubOidcProvider.openIdConnectProviderArn,
          {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            },
            StringLike: {
              // Only tag pushes matching v* from this repo can assume the role
              'token.actions.githubusercontent.com:sub':
                'repo:Orgeloth/email-unsubscribe:ref:refs/tags/v*',
            },
          }
        ),
      });

      // Allow the role to assume CDK bootstrap roles, which hold the actual deploy permissions
      deployRole.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }));

      // Allow the role to invalidate the CloudFront cache post-deploy
      deployRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudfront:ListDistributions', 'cloudfront:CreateInvalidation'],
        resources: ['*'],
      }));

      new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
        value: deployRole.roleArn,
        description: 'Set this as the AWS_DEPLOY_ROLE_ARN secret in GitHub',
      });
    }

    // ---------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'Raw Lambda Function URL (origin — use the custom domain instead)',
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${domain}`,
      description: 'App URL',
    });

    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: sessionsTable.tableName,
    });

    new cdk.CfnOutput(this, 'AllowlistTableName', {
      value: allowlistTable.tableName,
    });

    new cdk.CfnOutput(this, 'HistoryTableName', {
      value: historyTable.tableName,
    });

    new cdk.CfnOutput(this, 'AnalyticsTableName', {
      value: analyticsTable.tableName,
    });
  }
}
