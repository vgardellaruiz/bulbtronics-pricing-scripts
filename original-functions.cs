 ProductDetail.cshtml
       	var price = ProductItemManager.GetPrice(productDetail.ID,productDetail.PROD_SKU, productDetail.CATEGORY, productDetail.REF_COST, productDetail.PROD_MAX_SELLPRICE, isMemberNull, custId, buyingGroup, PRICETIER, PRICEMARKUP, custCategory, productDetail.PROD_MAP_SELLPRICE.GetValueOrDefault());
 
 
 
ProdItemManager.cs
       	public static decimal GetPrice(string prodID, string prod_sku, string category, double ref_Cost, double maxSellPrice, bool ismemberNull,  string custId, string buyingGroup, string PRICETIER, double PRICEMARKUP, string custcategory, double mapSellPrice = 0)
     	{
 
         	PriceManager price = new PriceManager();
         	decimal prodprice = 0, qbprodprice = 0, prodmarkup, qbprodmarkup, prodcost, qbprodcost, maxprice;
         	string inprodid = "";
         	bool spec_price_exists = false;
         	inprodid = prodID;
 
 
 
         	spec_price_exists = price.CheckSpecialProdPrice(prod_sku,ismemberNull, custId, buyingGroup, custcategory, ref prodprice);
         	if (spec_price_exists)
         	{
             	return prodprice;
         	}
         	prodmarkup = price.GetProdMarkup(category, PRICETIER, PRICEMARKUP);
         	prodcost = Convert.ToDecimal(ref_Cost);
         	prodprice = Decimal.Round(prodmarkup * prodcost / 100, 3);
         	maxprice = Convert.ToDecimal(maxSellPrice);
 
 
 
         	qbprodmarkup = price.GetProdMarkup("WP2", PRICETIER, PRICEMARKUP);
         	qbprodcost = Convert.ToDecimal(ref_Cost);
         	qbprodprice = Decimal.Round(qbprodmarkup * qbprodcost / 100, 3);
         	if (qbprodprice < maxprice)
         	{
             	maxprice = qbprodprice;
         	}
         	if (maxprice == 0)
         	{
             	maxprice = qbprodprice;
         	}
 
         	if (qbprodprice < Convert.ToDecimal(mapSellPrice))
         	{
             	prodprice = Convert.ToDecimal(mapSellPrice);
         	}
 
         	if (mapSellPrice > 0)
         	{
             	if (prodprice < Convert.ToDecimal(mapSellPrice))
              	{
                 	prodprice = Convert.ToDecimal(mapSellPrice);
             	}
         	}
 
 
 
 
         	if (prodprice > maxprice && maxprice > 0)
         	{
             	prodprice = maxprice;
         	}
 
         	return Convert.ToDecimal(prodprice.ToString("F"));
 
 
     	}
 
  price.CheckSpecialProdPrice
         	public bool CheckSpecialProdPrice(string inprodsku, bool isMemberNull, string custId, string buyingGroup, string custCategory, ref decimal outprice, string ContactRef = "", decimal ContractCost = 0)
     	{
         	int i = 0;
 
         	if (!priceloadstatus)
         	{
                 GetPricingTable(isMemberNull, custId, buyingGroup, custCategory);
             	priceloadstatus = true;
         	}
         	for (i = 0; i <= sp_pricetable.Rows.Count - 1; i++)
         	{
             	if (sp_pricetable.Rows[i]["SPECPR_TYPE"].ToString() == "CI" && sp_pricetable.Rows[i]["SPECPR_SKU"].ToString() == inprodsku && Convert.ToString(sp_pricetable.Rows[i]["SPECPR_APPROVER"]) != "")
             	{
                 	If (string.IsNullOrEmpty(sp_pricetable.Rows[i]["SPECPR_APPROVER"].ToString().Trim()))
                 	{
                     	return false;
                 	}
                 	outprice = Convert.ToDecimal(sp_pricetable.Rows[i]["SPECPR_PRICE"]);
                 	ContactRef = Convert.ToString(sp_pricetable.Rows[i]["SPECPR_CONTRACT_REF"]);
                 	ContractCost = Convert.ToDecimal(sp_pricetable.Rows[i]["SPECPR_CONTRACT_COST"]);
                 	return true;
             	}
         	}
         	for (i = 0; i <= sp_pricetable.Rows.Count - 1; i++)
         	{
             	if (sp_pricetable.Rows[i]["SPECPR_TYPE"].ToString() == "GP" && sp_pricetable.Rows[i]["SPECPR_SKU"].ToString() == inprodsku && Convert.ToString(sp_pricetable.Rows[i]["SPECPR_APPROVER"]) != "")
             	{
                 	If (string.IsNullOrEmpty(sp_pricetable.Rows[i]["SPECPR_APPROVER"].ToString().Trim()))
                 	{
                     	return false;
                 	}
                 	outprice = Convert.ToDecimal(sp_pricetable.Rows[i]["SPECPR_PRICE"]);
                 	ContactRef = Convert.ToString(sp_pricetable.Rows[i]["SPECPR_CONTRACT_REF"]);
                 	ContractCost = Convert.ToDecimal(sp_pricetable.Rows[i]["SPECPR_CONTRACT_COST"]);
                 	return true;
             	}
         	}
         	return false;
     	}
 
price.GetProdMarkup
       	public decimal GetProdMarkup(string inprodcat,string PRICETIER, double PRICEMARKUP)
     	{
 
         	int i = 0;
         	string deflevel = null;
         	string markup = "PRICE_MARKUP";
 
         	for (i = 0; i <= prod_pricetable.Rows.Count - 1; i++)
         	{
             	if  (prod_pricetable.Rows[i]["PRICE_PROD_CAT"].ToString().Trim() == inprodcat.Trim())
             	{
                 	if (Convert.ToInt32(PRICETIER) == 0)
                 	{
                     	deflevel = prod_pricetable.Rows[i]["PRICE_DEFAULT_LEVEL"].ToString().Trim();
                 	}
                 	else
                 	{
                     	deflevel = PRICETIER.ToString();
                 	}
                 	markup += deflevel.Trim();
                 	if (Convert.ToInt32(prod_pricetable.Rows[i][markup])  == 0)
                 	{
                     	markup = "PRICE_MARKUP" + prod_pricetable.Rows[i]["PRICE_SELECTIONS"].ToString();
                 	}
 
                 	return Convert.ToDecimal(Convert.ToDouble(prod_pricetable.Rows[i][markup]) + (PRICEMARKUP * 100));
             	}
         	}
         	return Convert.ToDecimal(999999.99);
     	}
 
GetPricingTable
     	public void GetPricingTable(bool isMemberNull, string custId, string buyingGroup, string custCategory)
     	{
 
         	if (isMemberNull == true)
         	{
             	sp_pricetable = ProdManager.SpecialPricingCust("106565", "IHU");
             	prod_pricetable = ProdManager.ProdPricingCust("WP2");
         	}
         	else if (string.IsNullOrEmpty(custCategory) && string.IsNullOrEmpty(buyingGroup))
         	{
             	sp_pricetable = ProdManager.SpecialPricingCust("106565", "IHU");
             	prod_pricetable = ProdManager.ProdPricingCust("WP2");
         	}
         	else
         	{
             	sp_pricetable = ProdManager.SpecialPricingCust(custId, buyingGroup);
             	prod_pricetable = ProdManager.ProdPricingCust(custCategory.Trim());
         	}
         	priceloadstatus = true;
     	}
 
 
ProdManager.SpecialPricingCust
      	public static DataTable SpecialPricingCust(string incustid, string incustgroup, string instatus = "A", string insku = "X")
     	{
         	DataTable temptable = new DataTable();
 
         	DataTable mydt = new DataTable();
         	DataTable mydt1 = new DataTable();
         	System.Data.SqlClient.SqlDataAdapter myad = new System.Data.SqlClient.SqlDataAdapter();
         	myad.SelectCommand = new System.Data.SqlClient.SqlCommand();
         	myad.SelectCommand.CommandText = "Select * from specpr where SPECPR_TYPE =  'CI'  AND SPECPR_KEY = @custid AND specpr_expire_date > @today";
         	if (instatus == "I")
         	{
             	myad.SelectCommand.CommandText = "Select * from specpr where SPECPR_TYPE =  'CI'  AND SPECPR_KEY = @custid AND SPECPR_SKU = @SKU ";
         	}
         	myad.SelectCommand.Parameters.Add("@custid", SqlDbType.VarChar).Value = incustid;
         	myad.SelectCommand.Parameters.Add("@SKU", SqlDbType.VarChar).Value = insku;
         	myad.SelectCommand.Parameters.Add("@today", SqlDbType.DateTime).Value = DateTime.Today;
         	myad.SelectCommand.Connection = TierManager.GetConnection("BulbProd");
         	myad.Fill(mydt);
         	myad.SelectCommand.Connection.Close();
         	myad.SelectCommand.Parameters.Clear();
         	myad.SelectCommand = new System.Data.SqlClient.SqlCommand();
         	myad.SelectCommand.CommandText = "Select * from specpr where SPECPR_TYPE =  'GP'  AND SPECPR_KEY = @groupid AND specpr_expire_date > @today";
         	if (instatus == "I")
         	{
             	myad.SelectCommand.CommandText = "Select * from specpr where SPECPR_TYPE =  'GP'  AND SPECPR_KEY = @groupid AND SPECPR_SKU = @SKU";
         	}
         	myad.SelectCommand.Parameters.Add("@groupid", SqlDbType.VarChar).Value = incustgroup;
         	myad.SelectCommand.Parameters.Add("@SKU", SqlDbType.VarChar).Value = insku;
         	myad.SelectCommand.Parameters.Add("@today", SqlDbType.DateTime).Value = DateTime.Today;
         	myad.SelectCommand.Connection = TierManager.GetConnection("BulbProd");
         	myad.Fill(mydt1);
         	myad.SelectCommand.Connection.Close();
         	mydt.Merge(mydt1);
         	return mydt;
     	}
 
ProdPricingCust
     	public static DataTable ProdPricingCust(string incustcat)
     	{
         	DataTable mydt = new DataTable();
         	System.Data.SqlClient.SqlDataAdapter myad = new System.Data.SqlClient.SqlDataAdapter();
         	if (incustcat.Length == 2)
             	incustcat += " ";
         	myad.SelectCommand = new System.Data.SqlClient.SqlCommand();
         	myad.SelectCommand.CommandText = "Select * from price where price_cust_cat =  @custcat";
         	myad.SelectCommand.Parameters.Add("@custcat", SqlDbType.VarChar).Value = incustcat;
         	myad.SelectCommand.Connection = TierManager.GetConnection("BulbProd");
         	myad.Fill(mydt);
         	myad.SelectCommand.Connection.Close();
         	return mydt;
     	}
 

